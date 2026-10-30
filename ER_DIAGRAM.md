# UML Class Diagram

This diagram models the core data entities in the CICR VAULT backend
(`users`, `inventory`, `borrow_records`, `audit_logs` in Supabase/Postgres) as UML
classes, including the main operations exposed on each via the Express API.

<img width="1061" height="914" alt="image" src="https://github.com/user-attachments/assets/4dbd9b6e-108e-4c9c-a1ac-35118ae7496e" />


## Accuracy notes

The entities, attributes, and relationship cardinalities in this diagram match the
real database schema (verified against the Supabase queries in
`backend/src/modules/**/*.controller.ts`). A couple of things worth knowing before
treating it as a literal description of the codebase:

* **The backend has no classes.** `register()`, `login()`, `getItems()`,
  `borrowItem()`, `logAudit()`, etc. are plain Express controller functions living in
  `backend/src/modules/<feature>/<feature>.controller.ts`, not methods on `User`,
  `InventoryItem`, or `BorrowRecord` objects. The diagram groups them under each
  entity for readability, but there's no OOP structure to match it 1:1.
* **`DashboardService`** is shown aggregating both `InventoryItem`/`User` stats and
  `AuditLog`, but in the code these are two separate endpoints, `GET /api/stats`
  (`getDashboardStats()`) and `GET /api/audit` (`getAuditLogs()`), not one combined
  call.
* `Category` (`Controllers | Sensors | Power | Actuators | Tools`) and `Role`
  (`ADMIN | MEMBER`) are correctly modeled as enums; `BorrowStatus`
  (`BORROWED | RETURNED`) likewise.
* `BorrowRecord.user_id` and `inventory_id`, and `AuditLog.user_id`/`item_id`, are
  foreign keys referencing `User` and `InventoryItem` respectively, the diagram's
  relationship lines capture this correctly even though the attribute list doesn't
  explicitly tag them `FK`.

## Entity summary

| Entity | Backed by table | Key relationships |
| ---------------- | ------------------ | ----------------------------------------------------- |
| `User` | `users` | 1 → many `BorrowRecord`, 1 → many `AuditLog` |
| `InventoryItem` | `inventory` | 1 → many `BorrowRecord`, 1 → many `AuditLog` |
| `BorrowRecord` | `borrow_records` | belongs to one `User`, one `InventoryItem` |
| `AuditLog` | `audit_logs` | optionally references one `User`, one `InventoryItem` |

There is no direct relationship between `AuditLog` and `BorrowRecord`, a
borrow/return action writes both a `BorrowRecord` row and a separate `AuditLog` row,
but they aren't foreign-keyed to each other.
