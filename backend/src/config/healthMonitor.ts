// Health monitoring and keep-alive (v2.1.0).
//
// Periodically pings Supabase (PRIMARY) and Neon (SECONDARY) to:
// 1. Detect failures early (before requests fail)
// 2. Keep databases warm (prevent scale-to-zero cold starts)
// 3. Track consecutive failures for failover decisions
// 4. Monitor Supabase health (primary database)
//
// When Supabase failure is confirmed (threshold exceeded) and a healthy
// Neon replica exists, triggers the failover state machine.
import {
  isNeonConfigured,
  isReplicaConfigured,
  checkPrimaryHealth,
  checkReplicaHealth,
  healthState,
  closeNeonPools,
} from './neonPool';
import { isSupabaseConfigured, checkSupabaseHealth } from './supabasePool';
import { setSupabaseHealthy, refreshDbContext, isSupabaseHealthy } from './dbHealth';
import { performRecovery } from './replication';
import { triggerFailover, getFailoverPhase, getWriteBufferLength } from './failover';

// ------------------------------------------------------------ configuration
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (Neon scales to zero after 5)
const DEFAULT_FAILURE_THRESHOLD = 3;               // consecutive failures before reporting unhealthy

export interface MonitorConfig {
  checkIntervalMs: number;
  failureThreshold: number;
}

function resolveConfig(): MonitorConfig {
  const interval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '', 10);
  const threshold = parseInt(process.env.HEALTH_FAILURE_THRESHOLD || '', 10);
  return {
    checkIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_CHECK_INTERVAL_MS,
    failureThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_FAILURE_THRESHOLD,
  };
}

// ------------------------------------------------------------ monitor state
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorConfig = resolveConfig();

// Supabase health tracking
let supabaseHealthy = true;
let supabaseConsecutiveFailures = 0;

// ------------------------------------------------------------ check cycle
async function runHealthCycle(): Promise<void> {
  // Pull shared (multi-instance) state before deciding anything.
  await refreshDbContext();

  // Check Supabase health (PRIMARY)
  if (isSupabaseConfigured()) {
    const supabaseOk = await checkSupabaseHealth();
    if (supabaseOk) {
      supabaseConsecutiveFailures = 0;
      // NEVER flip back to PRIMARY directly. If shared state says the primary is
      // not available, run the ordered recovery sequence (reconcile -> queue
      // empty -> sync -> PRIMARY). performRecovery dedupes across instances.
      if (!isSupabaseHealthy()) {
        const outcome = await performRecovery('auto');
        supabaseHealthy = isSupabaseHealthy();
        if (!outcome.success && !outcome.skipped) {
          console.error('[HEALTH] Auto-recovery did not complete — staying on SECONDARY');
        }
      } else {
        supabaseHealthy = true;
      }
    } else {
      supabaseConsecutiveFailures++;
      if (supabaseConsecutiveFailures === 1) {
        console.warn('[HEALTH] Supabase health check failed — monitoring');
      }
      if (supabaseConsecutiveFailures >= monitorConfig.failureThreshold) {
        console.error(`[HEALTH] Supabase marked UNHEALTHY after ${supabaseConsecutiveFailures} consecutive failures`);
        supabaseHealthy = false;
        setSupabaseHealthy(false);
      }
    }
  }

  // Check Neon health (SECONDARY) — only if Neon is configured
  if (!isNeonConfigured()) return;

  const primaryOk = await checkPrimaryHealth();
  const replicaOk = await checkReplicaHealth();

  // Log state transitions
  if (!primaryOk && healthState.primaryConsecutiveFailures === monitorConfig.failureThreshold) {
    console.error(
      `[HEALTH] Primary marked UNHEALTHY after ${monitorConfig.failureThreshold} consecutive failures`,
    );
  }

  if (primaryOk && healthState.primary === 'healthy') {
    // Recovery after failures
    if (healthState.failoverState === 'DEGRADED' || healthState.failoverState === 'BOTH_DOWN') {
      console.log('[HEALTH] Primary recovered — state transitions to HEALTHY');
      healthState.failoverState = 'HEALTHY';
    }
  }

  if (!primaryOk && replicaOk) {
    if (healthState.failoverState === 'HEALTHY') {
      console.warn('[HEALTH] Primary down, replica up — state transitions to DEGRADED');
      healthState.failoverState = 'DEGRADED';
    }
    // Trigger failover if threshold exceeded and no promotion already in progress
    if (
      healthState.primaryConsecutiveFailures >= monitorConfig.failureThreshold &&
      getFailoverPhase() === 'IDLE'
    ) {
      console.warn('[HEALTH] Failure threshold exceeded — triggering failover');
      triggerFailover().catch((err) => {
        console.error('[HEALTH] Failover trigger failed:', err.message);
      });
    }
  }

  if (!primaryOk && !replicaOk) {
    if (healthState.failoverState !== 'BOTH_DOWN') {
      console.error('[HEALTH] Both primary and replica down — state transitions to BOTH_DOWN');
      healthState.failoverState = 'BOTH_DOWN';
    }
  }
}

// ------------------------------------------------------------ lifecycle
export function startHealthMonitor(): void {
  if (!isNeonConfigured()) {
    console.log('[HEALTH] Neon not configured — health monitor not started');
    return;
  }

  monitorConfig = resolveConfig();

  if (monitorTimer) {
    clearInterval(monitorTimer);
  }

  // Run first check immediately (async, non-blocking)
  runHealthCycle().catch((err) => {
    console.error('[HEALTH] Initial health check failed:', err.message);
  });

  monitorTimer = setInterval(() => {
    runHealthCycle().catch((err) => {
      console.error('[HEALTH] Health check cycle failed:', err.message);
    });
  }, monitorConfig.checkIntervalMs);

  // Allow process to exit even if timer is running
  if (monitorTimer && typeof monitorTimer === 'object' && 'unref' in monitorTimer) {
    monitorTimer.unref();
  }

  console.log(`[HEALTH] Monitor started (interval: ${monitorConfig.checkIntervalMs}ms, threshold: ${monitorConfig.failureThreshold})`);
}

export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

// --------------------------------------------------- health endpoint payload
export interface HealthPayload {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  timestamp: string;
  supabase: {
    configured: boolean;
    healthy: boolean;
    consecutiveFailures: number;
  };
  neon: {
    configured: boolean;
    primary: string;
    replica: string;
  };
  database: {
    primary: string;
    replica: string;
    failoverState: string;
    failoverPhase: string;
    writeBufferLength: number;
    primaryConsecutiveFailures: number;
    lastPrimaryCheck: string | null;
    lastReplicaCheck: string | null;
  };
}

export function buildHealthPayload(): HealthPayload {
  const neonConfigured = isNeonConfigured();
  const supabaseConfigured = isSupabaseConfigured();
  const primaryHealthy = healthState.primary === 'healthy';
  const replicaHealthy = healthState.replica === 'healthy';

  let status: HealthPayload['status'];
  let message: string;

  // Determine overall status based on Supabase (PRIMARY) and Neon (SECONDARY)
  if (supabaseConfigured && supabaseHealthy) {
    status = 'healthy';
    message = 'CICR Inventory API is live! (Supabase PRIMARY healthy)';
  } else if (supabaseConfigured && !supabaseHealthy && neonConfigured && primaryHealthy) {
    status = 'degraded';
    message = 'Supabase unavailable — serving from Neon SECONDARY';
  } else if (!supabaseConfigured && neonConfigured && primaryHealthy) {
    status = 'healthy';
    message = 'CICR Inventory API is live! (Neon PRIMARY — Supabase not configured)';
  } else if (supabaseConfigured && !supabaseHealthy && neonConfigured && replicaHealthy) {
    status = 'degraded';
    message = 'Supabase and Neon primary unavailable — serving from Neon replica';
  } else if (!neonConfigured && !supabaseConfigured) {
    status = 'healthy';
    message = 'CICR Inventory API is live! (Legacy mode — no external DB configured)';
  } else if (healthState.primary === 'unknown' || healthState.replica === 'unknown') {
    status = 'healthy';
    message = 'Health check initializing — first probe pending';
  } else {
    status = 'unhealthy';
    message = 'All database endpoints unavailable';
  }

  return {
    status,
    message,
    timestamp: new Date().toISOString(),
    supabase: {
      configured: supabaseConfigured,
      healthy: supabaseHealthy,
      consecutiveFailures: supabaseConsecutiveFailures,
    },
    neon: {
      configured: neonConfigured,
      primary: neonConfigured ? 'configured' : '(not configured)',
      replica: healthState.currentReplicaHost ? 'configured' : '(not configured)',
    },
    database: {
      primary: healthState.primary,
      replica: healthState.replica,
      failoverState: healthState.failoverState,
      failoverPhase: getFailoverPhase(),
      writeBufferLength: getWriteBufferLength(),
      primaryConsecutiveFailures: healthState.primaryConsecutiveFailures,
      lastPrimaryCheck: healthState.lastPrimaryCheck?.toISOString() || null,
      lastReplicaCheck: healthState.lastReplicaCheck?.toISOString() || null,
    },
  };
}

// Export for graceful shutdown
export { closeNeonPools };
