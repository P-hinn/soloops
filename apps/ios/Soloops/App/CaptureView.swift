import SoloopsKit
import SwiftUI

/// One field, three things it can become.
///
/// The phone's job is catching something before it is forgotten — in the car
/// park after a meeting, on the way to the train. That is a different job from
/// the Mac's, where a lead gets a value, a stage and a close date. So this
/// takes a sentence and nothing else, and anything further happens later at
/// the desk.
///
/// It writes to the local database, not to the API. Everything here therefore
/// works with no network at all and travels on the next sync — which is the
/// whole reason for the op log, and the difference between a capture box that
/// is trusted and one that is not.
struct CaptureView: View {
    @Environment(AppEnvironment.self) private var environment
    @FocusState private var typing: Bool

    @State private var text = ""
    @State private var saved: Saved?
    @State private var error: String?

    private struct Saved: Equatable {
        let kind: Capture.Kind
        let title: String
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Paper.paper.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("Erfassen")
                        .padding(.horizontal, 20)
                        .padding(.top, 8)

                    Text("Ein Satz genügt.")
                        .font(Display.font(26, .bold))
                        .padding(.horizontal, 20)
                        .padding(.top, 4)

                    TextEditor(text: $text)
                        .focused($typing)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .background(Paper.raised)
                        .overlay(alignment: .topLeading) {
                            if text.isEmpty {
                                Text("Angebot für Muster AG nachfassen")
                                    .font(.body)
                                    .foregroundStyle(Paper.muted)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                        .padding(10)
                        .background(Paper.raised)
                        .overlay(Rectangle().stroke(Paper.lineStrong, lineWidth: 1))
                        .frame(height: 150)
                        .padding(.horizontal, 20)
                        .padding(.top, 18)

                    if let hint = Capture.dueHint(in: text) {
                        Label(hint, systemImage: "calendar")
                            .font(.footnote)
                            .foregroundStyle(Paper.soft)
                            .padding(.horizontal, 20)
                            .padding(.top, 8)
                    }

                    VStack(spacing: 10) {
                        ForEach(Capture.Kind.allCases, id: \.self) { kind in
                            Button(kind.action) { Task { await save(as: kind) } }
                                .buttonStyle(PillButton(kind: kind == .lead ? .primary : .ghost))
                                .disabled(trimmed.isEmpty)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 18)

                    if let saved {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Paper.good)
                            Text("\(saved.kind.noun) angelegt: \(saved.title)")
                                .font(.footnote)
                                .foregroundStyle(Paper.soft)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                    }

                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Paper.bad)
                            .padding(.horizontal, 20)
                            .padding(.top, 16)
                    }

                    Spacer()
                }
            }
            .navigationTitle("Neu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .keyboard) {
                    Button("Fertig") { typing = false }
                }
            }
        }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save(as kind: Capture.Kind) async {
        guard let engine = environment.engine else {
            error = "Noch nicht gekoppelt."
            return
        }
        error = nil

        let draft = Capture.draft(from: trimmed, as: kind)
        do {
            _ = try await engine.recordLocal(
                entity: kind.entity,
                id: UUID().uuidString,
                patch: draft.patch,
                isCreate: true
            )
            saved = Saved(kind: kind, title: draft.title)
            text = ""
            typing = false
            // Already safe in the log; this only gets it across sooner.
            await environment.sync()
        } catch {
            self.error = "Konnte nicht gespeichert werden: \(error)"
        }
    }
}
