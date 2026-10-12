import Foundation

/// The one isolation domain that touches the local database.
///
/// There is a single SQLite connection behind `Store`, and three things want
/// it: the UI reads through `Agenda`, the user's own edits go in through
/// `SyncEngine`, and `SyncCoordinator` applies what the Mac sends. Those are
/// not the same thread, and a connection used from two of them at once
/// corrupts the file rather than merely racing.
///
/// A global actor instead of making `Store` an actor of its own: the engine,
/// the agenda and the coordinator all belong to the same domain anyway, so
/// this keeps every call *between* them synchronous and puts the `await` only
/// where the boundary really is — at the UI.
@globalActor
public actor SyncActor {
    public static let shared = SyncActor()
}
