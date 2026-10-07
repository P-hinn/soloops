import Foundation
import SQLite3

/// The phone's copy of the data, and its op log.
///
/// Raw SQLite rather than a wrapper library, because the repository's rule is
/// no new dependencies without asking and `libsqlite3` is already in the SDK.
/// The surface needed here is small — the tables are generated from the entity
/// registry, and nothing does a join.
///
/// The schema deliberately mirrors the API's: one table per synced entity with
/// exactly the columns in `SyncEntities`, plus `SyncOp` and a key/value table.
/// Dates are stored as the ISO strings they arrive as, so a row read back and
/// pushed again is byte-identical to what the Mac sent.
public final class Store {
    public enum StoreError: Error, Equatable {
        case open(String)
        case sql(String)
    }

    private var db: OpaquePointer?
    /// Recursive, so that `transaction` can hold it across the statements it
    /// wraps. A plain `NSLock` would deadlock on the first query inside the
    /// block; releasing it between statements instead would let another thread
    /// interleave its writes into an open transaction, which is the bug this
    /// lock exists to prevent.
    private let lock = NSRecursiveLock()

    public init(path: String) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unbekannt"
            throw StoreError.open(message)
        }
        self.db = handle

        // WAL so a background sync can write while the UI reads. Without it
        // the agenda view blocks for as long as a push takes.
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA foreign_keys=OFF")
        try migrate()
    }

    deinit {
        if let db { sqlite3_close_v2(db) }
    }

    // --- Schema ------------------------------------------------------------

    /// Build the tables from the registry.
    ///
    /// Generated rather than written out, so a field added to `SyncEntities`
    /// cannot be forgotten here. Adding a column to an existing install is
    /// handled by the `ALTER TABLE` pass below, which is the whole migration
    /// story this app needs: one user, one device, and the Mac is the copy of
    /// record anyway.
    private func migrate() throws {
        for spec in SyncEntities.all {
            let columns =
                spec.fieldOrder
                .map { "\"\($0)\" \(spec.fields[$0]!.columnType)" }
                .joined(separator: ", ")
            try exec(
                """
                CREATE TABLE IF NOT EXISTS "\(spec.table)" (
                  id TEXT PRIMARY KEY NOT NULL\(columns.isEmpty ? "" : ", " + columns)
                )
                """
            )

            // A newer build of the app may know fields this database predates.
            let existing = try columnNames(of: spec.table)
            for field in spec.fieldOrder where !existing.contains(field) {
                try exec(
                    "ALTER TABLE \"\(spec.table)\" ADD COLUMN \"\(field)\" \(spec.fields[field]!.columnType)"
                )
            }
        }

        try exec(
            """
            CREATE TABLE IF NOT EXISTS SyncOp (
              deviceId TEXT NOT NULL,
              seq      INTEGER NOT NULL,
              hlc      TEXT NOT NULL,
              entity   TEXT NOT NULL,
              entityId TEXT NOT NULL,
              op       TEXT NOT NULL,
              patch    TEXT,
              fields   TEXT NOT NULL DEFAULT '',
              -- Set once the Mac has acknowledged this op. Null means it is
              -- still ours alone and has to go out on the next push.
              pushedAt TEXT,
              PRIMARY KEY (deviceId, seq)
            )
            """
        )
        try exec("CREATE INDEX IF NOT EXISTS syncop_hlc ON SyncOp(hlc)")
        try exec("CREATE INDEX IF NOT EXISTS syncop_row ON SyncOp(entity, entityId, hlc)")
        try exec("CREATE INDEX IF NOT EXISTS syncop_unpushed ON SyncOp(pushedAt, hlc)")
        try exec("CREATE TABLE IF NOT EXISTS Meta (key TEXT PRIMARY KEY NOT NULL, value TEXT)")
    }

    private func columnNames(of table: String) throws -> Set<String> {
        var names = Set<String>()
        try query("PRAGMA table_info(\"\(table)\")") { stmt in
            if let c = sqlite3_column_text(stmt, 1) { names.insert(String(cString: c)) }
        }
        return names
    }

    // --- Key/value ---------------------------------------------------------

    public func meta(_ key: String) throws -> String? {
        var out: String?
        try query("SELECT value FROM Meta WHERE key = ?", bind: [.string(key)]) { stmt in
            if let c = sqlite3_column_text(stmt, 0) { out = String(cString: c) }
        }
        return out
    }

    public func setMeta(_ key: String, _ value: String) throws {
        try run(
            "INSERT INTO Meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            bind: [.string(key), .string(value)]
        )
    }

    // --- Rows --------------------------------------------------------------

    public func exists(entity: String, id: String) throws -> Bool {
        guard let spec = SyncEntities.spec(entity) else { return false }
        var found = false
        try query(
            "SELECT 1 FROM \"\(spec.table)\" WHERE id = ? LIMIT 1",
            bind: [.string(id)]
        ) { _ in found = true }
        return found
    }

    /// One row as a patch, which is also what a push needs.
    public func row(entity: String, id: String) throws -> Patch? {
        guard let spec = SyncEntities.spec(entity) else { return nil }
        let columns = spec.fieldOrder.map { "\"\($0)\"" }.joined(separator: ", ")
        var out: Patch?
        try query(
            "SELECT \(columns) FROM \"\(spec.table)\" WHERE id = ?",
            bind: [.string(id)]
        ) { stmt in
            var patch: Patch = [:]
            for (index, field) in spec.fieldOrder.enumerated() {
                patch[field] = Self.read(stmt, index: Int32(index), kind: spec.fields[field]!)
            }
            out = patch
        }
        return out
    }

    /// Rows in a plain order, for the lists the app shows.
    public func rows(
        entity: String,
        where clause: String? = nil,
        bind values: [Value] = [],
        orderBy: String? = nil,
        limit: Int? = nil
    ) throws -> [(id: String, patch: Patch)] {
        guard let spec = SyncEntities.spec(entity) else { return [] }
        let columns = (["id"] + spec.fieldOrder.map { "\"\($0)\"" }).joined(separator: ", ")
        var sql = "SELECT \(columns) FROM \"\(spec.table)\""
        if let clause { sql += " WHERE \(clause)" }
        if let orderBy { sql += " ORDER BY \(orderBy)" }
        if let limit { sql += " LIMIT \(limit)" }

        var out: [(id: String, patch: Patch)] = []
        try query(sql, bind: values) { stmt in
            guard let idRaw = sqlite3_column_text(stmt, 0) else { return }
            var patch: Patch = [:]
            for (index, field) in spec.fieldOrder.enumerated() {
                patch[field] = Self.read(stmt, index: Int32(index + 1), kind: spec.fields[field]!)
            }
            out.append((id: String(cString: idRaw), patch: patch))
        }
        return out
    }

    /// Insert or update, writing only the fields in the patch.
    public func write(entity: String, id: String, patch: Patch, isCreate: Bool) throws {
        guard let spec = SyncEntities.spec(entity) else { return }
        let fields = patch.keys.sorted().filter { spec.fields[$0] != nil }
        guard !fields.isEmpty || isCreate else { return }

        if isCreate {
            let columns = (["id"] + fields.map { "\"\($0)\"" }).joined(separator: ", ")
            let holes = Array(repeating: "?", count: fields.count + 1).joined(separator: ", ")
            let values: [Value] = [.string(id)] + fields.map { Self.bindable(patch[$0]!) }
            try run(
                "INSERT OR REPLACE INTO \"\(spec.table)\" (\(columns)) VALUES (\(holes))",
                bind: values
            )
        } else {
            let assignments = fields.map { "\"\($0)\" = ?" }.joined(separator: ", ")
            let values: [Value] = fields.map { Self.bindable(patch[$0]!) } + [.string(id)]
            try run("UPDATE \"\(spec.table)\" SET \(assignments) WHERE id = ?", bind: values)
        }
    }

    public func delete(entity: String, id: String) throws {
        guard let spec = SyncEntities.spec(entity) else { return }
        try run("DELETE FROM \"\(spec.table)\" WHERE id = ?", bind: [.string(id)])
    }

    /// The ids a delete of these rows would also affect.
    ///
    /// SQLite here has foreign keys switched off and no cascades, so the app
    /// resolves them the same way the Mac's Prisma hook does. Both sides have
    /// to produce the same ops for the same delete — otherwise one device
    /// keeps rows the other has dropped.
    public func childrenAffectedBy(entity: String, ids: [String]) throws -> [(
        kind: SideEffect.Kind, entity: String, fk: String, id: String
    )] {
        guard let spec = SyncEntities.spec(entity), !ids.isEmpty else { return [] }
        var out: [(kind: SideEffect.Kind, entity: String, fk: String, id: String)] = []

        for effect in spec.sideEffects {
            guard let childSpec = SyncEntities.spec(effect.entity) else { continue }
            let holes = Array(repeating: "?", count: ids.count).joined(separator: ", ")
            try query(
                "SELECT id FROM \"\(childSpec.table)\" WHERE \"\(effect.fk)\" IN (\(holes))",
                bind: ids.map { .string($0) }
            ) { stmt in
                guard let c = sqlite3_column_text(stmt, 0) else { return }
                out.append((
                    kind: effect.kind, entity: effect.entity, fk: effect.fk,
                    id: String(cString: c)
                ))
            }
        }
        return out
    }

    // --- The op log --------------------------------------------------------

    public func appendOp(_ op: SyncOp, pushed: Bool) throws {
        let patchJson: Value
        if let patch = op.patch,
            let data = try? JSONSerialization.data(withJSONObject: SyncCodec.jsonObject(patch)),
            let text = String(data: data, encoding: .utf8)
        {
            patchJson = .string(text)
        } else {
            patchJson = .null
        }

        // `OR IGNORE`: the same op arriving twice is the expected case on the
        // iCloud route, which has no delivery receipt.
        try run(
            """
            INSERT OR IGNORE INTO SyncOp
              (deviceId, seq, hlc, entity, entityId, op, patch, fields, pushedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            bind: [
                .string(op.deviceId), .int(op.seq), .string(op.hlc), .string(op.entity),
                .string(op.entityId), .string(op.op.rawValue), patchJson,
                .string(op.fields.joined(separator: ",")),
                pushed ? .string(SyncCodec.isoString(Date())) : .null,
            ]
        )
    }

    public func knownOps(entity: String, entityId: String) throws -> [Merge.KnownOp] {
        var out: [Merge.KnownOp] = []
        try query(
            "SELECT hlc, op, fields FROM SyncOp WHERE entity = ? AND entityId = ?",
            bind: [.string(entity), .string(entityId)]
        ) { stmt in
            let hlc = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            let kind = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? "upsert"
            let fields = sqlite3_column_text(stmt, 2).map { String(cString: $0) } ?? ""
            out.append(
                Merge.KnownOp(
                    hlc: hlc,
                    op: OpKind(rawValue: kind) ?? .upsert,
                    fields: fields.isEmpty ? [] : fields.split(separator: ",").map(String.init)
                )
            )
        }
        return out
    }

    public func hasOp(deviceId: String, seq: Int) throws -> Bool {
        var found = false
        try query(
            "SELECT 1 FROM SyncOp WHERE deviceId = ? AND seq = ? LIMIT 1",
            bind: [.string(deviceId), .int(seq)]
        ) { _ in found = true }
        return found
    }

    /// Everything this device has made and not yet handed over.
    public func unpushedOps(limit: Int) throws -> [SyncOp] {
        var out: [SyncOp] = []
        try query(
            """
            SELECT deviceId, seq, hlc, entity, entityId, op, patch
            FROM SyncOp WHERE pushedAt IS NULL ORDER BY hlc ASC LIMIT \(limit)
            """
        ) { stmt in
            let text = { (i: Int32) in sqlite3_column_text(stmt, i).map { String(cString: $0) } }
            guard let deviceId = text(0), let hlc = text(2), let entity = text(3),
                let entityId = text(4), let kindRaw = text(5),
                let kind = OpKind(rawValue: kindRaw)
            else { return }

            var patch: Patch?
            if kind == .upsert, let raw = text(6), let data = raw.data(using: .utf8),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                patch = try? SyncCodec.patch(from: object, entity: entity)
            }

            out.append(
                SyncOp(
                    deviceId: deviceId,
                    seq: Int(sqlite3_column_int64(stmt, 1)),
                    hlc: hlc,
                    entity: entity,
                    entityId: entityId,
                    op: kind,
                    patch: patch
                )
            )
        }
        return out
    }

    public func markPushed(deviceId: String, seqs: [Int]) throws {
        guard !seqs.isEmpty else { return }
        let holes = Array(repeating: "?", count: seqs.count).joined(separator: ", ")
        try run(
            "UPDATE SyncOp SET pushedAt = ? WHERE deviceId = ? AND seq IN (\(holes))",
            bind: [.string(SyncCodec.isoString(Date())), .string(deviceId)]
                + seqs.map { .int($0) }
        )
    }

    public func nextSeq(deviceId: String) throws -> Int {
        var highest = 0
        try query(
            "SELECT COALESCE(MAX(seq), 0) FROM SyncOp WHERE deviceId = ?",
            bind: [.string(deviceId)]
        ) { stmt in highest = Int(sqlite3_column_int64(stmt, 0)) }
        return highest + 1
    }

    public func newestHlc() throws -> String {
        var newest = ""
        try query("SELECT COALESCE(MAX(hlc), '') FROM SyncOp") { stmt in
            newest = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
        }
        return newest
    }

    // --- Transactions ------------------------------------------------------

    public func transaction<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }

        try exec("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try exec("COMMIT")
            return result
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    // --- The thin SQLite layer ---------------------------------------------

    public enum Value {
        case null
        case string(String)
        case int(Int)
        case double(Double)
    }

    static func bindable(_ value: SyncValue) -> Value {
        switch value {
        case .null: return .null
        case .string(let s): return .string(s)
        case .isoDate(let s): return .string(s)
        case .int(let i): return .int(i)
        case .bool(let b): return .int(b ? 1 : 0)
        case .strings(let a), .dates(let a):
            // A JSON array in a text column. The alternative is a side table
            // per list field, which buys nothing: nothing queries into them.
            let data = try? JSONSerialization.data(withJSONObject: a)
            return .string(data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]")
        case .json(let data):
            return .string(String(data: data, encoding: .utf8) ?? "null")
        }
    }

    static func read(_ stmt: OpaquePointer?, index: Int32, kind: FieldKind) -> SyncValue {
        guard sqlite3_column_type(stmt, index) != SQLITE_NULL else { return .null }

        switch kind {
        case .int: return .int(Int(sqlite3_column_int64(stmt, index)))
        case .bool: return .bool(sqlite3_column_int64(stmt, index) != 0)
        case .string:
            return .string(sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? "")
        case .date:
            return .isoDate(sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? "")
        case .strings, .dates:
            let text = sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? "[]"
            let array =
                (text.data(using: .utf8)
                    .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String]) ?? []
            return kind == .strings ? .strings(array) : .dates(array)
        case .json:
            let text = sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? "null"
            return .json(Data(text.utf8))
        }
    }

    private func exec(_ sql: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? "unbekannt"
            sqlite3_free(error)
            throw StoreError.sql("\(message) — \(sql)")
        }
    }

    private func run(_ sql: String, bind values: [Value] = []) throws {
        try query(sql, bind: values) { _ in }
    }

    private func query(
        _ sql: String,
        bind values: [Value] = [],
        each: (OpaquePointer?) throws -> Void
    ) throws {
        lock.lock()
        defer { lock.unlock() }

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.sql("\(String(cString: sqlite3_errmsg(db))) — \(sql)")
        }
        defer { sqlite3_finalize(stmt) }

        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case .null: sqlite3_bind_null(stmt, position)
            case .string(let s): sqlite3_bind_text(stmt, position, s, -1, SQLITE_TRANSIENT)
            case .int(let i): sqlite3_bind_int64(stmt, position, Int64(i))
            case .double(let d): sqlite3_bind_double(stmt, position, d)
            }
        }

        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_ROW {
                try each(stmt)
            } else if step == SQLITE_DONE {
                return
            } else {
                throw StoreError.sql("\(String(cString: sqlite3_errmsg(db))) — \(sql)")
            }
        }
    }
}

/// `SQLITE_TRANSIENT` is a function pointer macro in C and does not come
/// through the Swift importer, so it is rebuilt here. It tells SQLite to copy
/// the string, which it has to: the Swift value is gone after the call.
private let SQLITE_TRANSIENT = unsafeBitCast(
    -1,
    to: sqlite3_destructor_type.self
)
