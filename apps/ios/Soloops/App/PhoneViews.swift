import SoloopsKit
import SwiftUI

/// The phone side.
///
/// Deliberately small. The Mac has the full interface; what belongs on the
/// phone is the day, the follow-ups, the drives waiting to be assigned, and
/// the state of the sync — the things you look at when the laptop is shut.
struct PairingView: View {
    @Environment(AppEnvironment.self) private var environment

    @State private var scanning = false
    @State private var manual = false
    @State private var code = ""
    @State private var host = ""
    @State private var failure: AppEnvironment.PairingFailure?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ZStack {
                Paper.paper.ignoresSafeArea()
                VStack(spacing: 0) {
                Spacer(minLength: 0)

                VStack(spacing: 10) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 56, weight: .light))
                        .foregroundStyle(Paper.muted)
                    Eyebrow("Einrichten")
                    Text("Mit dem Mac koppeln")
                        .font(Display.font(26, .bold))
                    Text("Am Mac unter Einstellungen → iPhone einen Code erzeugen. Dann hier scannen — Adresse und Code stecken im Bild.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Button {
                    failure = nil
                    scanning = true
                } label: {
                    Label(busy ? "Koppeln …" : "QR-Code scannen", systemImage: "camera.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PillButton())
                .disabled(busy)
                .padding(.horizontal, 32)
                .padding(.top, 28)

                Button("Ohne Kamera eingeben") { manual = true }
                    .font(.footnote)
                    .padding(.top, 14)

                if let failure {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(failure.message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        if failure.mayBeLocalNetwork {
                            // iOS asks for local network access once. Refused, it
                            // fails every request without a word and never asks
                            // again — so the only way back is Settings.
                            Button("Einstellungen öffnen") {
                                guard let url = URL(string: UIApplication.openSettingsURLString)
                                else { return }
                                UIApplication.shared.open(url)
                            }
                            .font(.footnote)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 32)
                    .padding(.top, 20)
                }

                Spacer(minLength: 0)
                }
            }
            .navigationTitle("soloops")
            .paperChrome()
            .navigationBarTitleDisplayMode(.inline)
        }
        .fullScreenCover(isPresented: $scanning) {
            ScanSheet { scanned in
                scanning = false
                Task { await redeem(scanned) }
            } onCancel: {
                scanning = false
            }
        }
        .sheet(isPresented: $manual) {
            ManualPairingSheet(code: $code, host: $host, busy: busy) {
                manual = false
                // The port is the API's default. This path exists for the case
                // where the camera cannot read the screen, not as the way in.
                let invitation = Pairing.Invitation(code: code, addresses: [host], port: 3000)
                Task { await pair(with: invitation) }
            }
        }
    }

    private func redeem(_ scanned: String) async {
        guard let url = URL(string: scanned), let invitation = Pairing.Invitation(url: url) else {
            failure = AppEnvironment.PairingFailure(
                message: "Das war kein Kopplungscode von soloops.",
                mayBeLocalNetwork: false
            )
            return
        }
        await pair(with: invitation)
    }

    private func pair(with invitation: Pairing.Invitation) async {
        busy = true
        defer { busy = false }
        failure = await environment.pair(with: invitation)
    }
}

/// The camera, with a way out.
private struct ScanSheet: View {
    let onFound: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            QrScanner(onFound: onFound)
                .ignoresSafeArea()

            HStack {
                Button("Abbrechen", action: onCancel)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                Spacer()
            }
            .padding()
        }
        .overlay(alignment: .center) {
            // A frame to aim with. Nothing is cropped to it — the whole image
            // is searched — but a viewfinder without one invites holding the
            // phone too far away.
            RoundedRectangle(cornerRadius: 16)
                .stroke(.white.opacity(0.9), lineWidth: 2)
                .frame(width: 230, height: 230)
        }
        .overlay(alignment: .bottom) {
            Text("Auf den Code am Mac halten")
                .font(.callout)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.bottom, 40)
        }
    }
}

private struct ManualPairingSheet: View {
    @Binding var code: String
    @Binding var host: String
    let busy: Bool
    let onSubmit: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("Adresse des Macs", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Beides steht am Mac unter Einstellungen → iPhone, hinter „Ohne Kamera eingeben\".")
                }
            }
            .navigationTitle("Von Hand")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Koppeln", action: onSubmit)
                        .disabled(busy || code.isEmpty || host.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

struct MainView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        TabView {
            Tab("Neu", systemImage: "square.and.pencil") { CaptureView() }
            Tab("Heute", systemImage: "calendar") { TodayView() }
            Tab("Wiedervorlage", systemImage: "arrow.uturn.backward") { FollowUpView() }
            Tab("Fahrten", systemImage: "car") { DrivesView() }
            Tab("Abgleich", systemImage: "arrow.triangle.2.circlepath") { SyncView() }
        }
        .tint(Paper.ink)
    }
}

struct TodayView: View {
    @Environment(AppEnvironment.self) private var environment
    private let briefing = Briefing()

    // Loaded rather than read in `body`: the database is on its own actor now,
    // and a body cannot await. It was the wrong place anyway — a read in there
    // runs again on every redraw.
    @State private var events: [AgendaEvent] = []
    @State private var tasks: [AgendaTask] = []

    var body: some View {
        NavigationStack {
            List {
                if events.isEmpty {
                    ContentUnavailableView("Keine Termine heute", systemImage: "calendar")
                } else {
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.allDay ? "ganztägig" : briefing.time(event.startsAt))
                                .font(Display.font(12, .medium))
                                .monospacedDigit()
                                .foregroundStyle(Paper.blue)
                            Text(event.title)
                            if let location = event.location, !location.isEmpty {
                                Text(location).font(.caption).foregroundStyle(Paper.muted)
                            }
                        }
                        .listRowBackground(Paper.paper)
                        .listRowSeparatorTint(Paper.line)
                    }
                }

                if !tasks.isEmpty {
                    Section {
                        ForEach(tasks) { task in
                            Button {
                                Task { await tick(task) }
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Image(systemName: "circle")
                                        .foregroundStyle(Paper.lineStrong)
                                    Text(task.title)
                                        .foregroundStyle(Paper.ink)
                                }
                            }
                            .listRowBackground(Paper.paper)
                            .listRowSeparatorTint(Paper.line)
                        }
                    } header: {
                        Eyebrow("Offene Punkte")
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Paper.paper)
            .navigationTitle("Heute")
            .paperChrome()
            .task { await load() }
            .refreshable {
                await environment.sync()
                await load()
            }
        }
    }

    private func load() async {
        guard let agenda = environment.agenda else {
            events = []
            tasks = []
            return
        }
        events = (try? await agenda.events(on: Date())) ?? []
        tasks = (try? await agenda.openTasks(limit: 10)) ?? []
    }

    private func tick(_ task: AgendaTask) async {
        guard let engine = environment.engine else { return }
        _ = try? await engine.recordLocal(
            entity: "ActionItem", id: task.id, patch: ["done": .bool(true)], isCreate: false)
        await environment.sync()
        await load()
    }
}

struct FollowUpView: View {
    @Environment(AppEnvironment.self) private var environment
    private let briefing = Briefing()

    @State private var due: [AgendaFollowUp] = []

    var body: some View {
        NavigationStack {
            List {
                if due.isEmpty {
                    ContentUnavailableView("Nichts offen", systemImage: "checkmark.circle")
                } else {
                    ForEach(due) { followUp in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(followUp.title).foregroundStyle(Paper.ink)
                            Text(briefing.line(for: followUp, at: Date()))
                                .font(.caption)
                                .foregroundStyle(Paper.muted)
                        }
                        .listRowBackground(Paper.paper)
                        .listRowSeparatorTint(Paper.line)
                        .swipeActions {
                            Button("Erledigt") { Task { await clear(followUp) } }.tint(.green)
                            Button("Morgen") { Task { await postpone(followUp) } }.tint(.orange)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Paper.paper)
            .navigationTitle("Wiedervorlage")
            .paperChrome()
            .task { await load() }
            .refreshable {
                await environment.sync()
                await load()
            }
        }
    }

    private func load() async {
        guard let agenda = environment.agenda else {
            due = []
            return
        }
        due = (try? await agenda.dueFollowUps(at: Date())) ?? []
    }

    private func clear(_ followUp: AgendaFollowUp) async {
        guard let engine = environment.engine else { return }
        _ = try? await engine.recordLocal(
            entity: "Lead", id: followUp.id,
            patch: ["followUpOn": .null, "followUpNote": .null], isCreate: false)
        await environment.sync()
        await load()
    }

    private func postpone(_ followUp: AgendaFollowUp) async {
        guard let engine = environment.engine else { return }
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        _ = try? await engine.recordLocal(
            entity: "Lead", id: followUp.id,
            patch: ["followUpOn": .isoDate(SyncCodec.isoString(tomorrow))], isCreate: false)
        await environment.sync()
        await load()
    }
}

/// Drives the car recorded but could not place.
///
/// This screen is the reason the travel timer is allowed to guess at all: a
/// drive it cannot match waits here instead of being booked against the wrong
/// customer.
struct DrivesView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var suggestions: [CarPlayTravel.Suggestion] = []

    var body: some View {
        NavigationStack {
            List {
                if suggestions.isEmpty {
                    ContentUnavailableView(
                        "Keine offenen Fahrten",
                        systemImage: "car",
                        description: Text(
                            "Fahrten mit passendem Termin werden direkt gebucht.")
                    )
                } else {
                    ForEach(suggestions) { suggestion in
                        NavigationLink {
                            AssignDriveView(suggestion: suggestion) { reload() }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(suggestion.description).foregroundStyle(Paper.ink)
                                Text(
                                    "\(suggestion.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(Int(suggestion.endedAt.timeIntervalSince(suggestion.startedAt) / 60)) min"
                                )
                                .font(.caption)
                                .foregroundStyle(Paper.muted)
                            }
                        }
                        .listRowBackground(Paper.paper)
                        .listRowSeparatorTint(Paper.line)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Paper.paper)
            .navigationTitle("Fahrten")
            .paperChrome()
            .onAppear { reload() }
        }
    }

    private func reload() {
        suggestions = CarPlayTravel.shared.suggestions
    }
}

struct AssignDriveView: View {
    let suggestion: CarPlayTravel.Suggestion
    let onDone: () -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var projects: [(id: String, name: String, clientId: String?)] = []

    var body: some View {
        List {
            Section("Auf welches Projekt?") {
                ForEach(projects, id: \.id) { project in
                    Button(project.name) {
                        Task {
                            await CarPlayTravel.shared.accept(
                                suggestion, projectId: project.id, clientId: project.clientId)
                            onDone()
                            dismiss()
                        }
                    }
                }
            }
            Section {
                Button("Fahrt verwerfen", role: .destructive) {
                    CarPlayTravel.shared.discard(suggestion)
                    onDone()
                    dismiss()
                }
            }
        }
        .navigationTitle(suggestion.description)
        .task {
            projects = (try? await environment.agenda?.activeProjects()) ?? []
        }
    }
}

struct SyncView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Weg", value: route)
                    LabeledContent(
                        "Erfolg",
                        value: environment.status.lastSuccess?.formatted(
                            date: .omitted, time: .standard) ?? "noch nie")
                    LabeledContent("Offen", value: "\(environment.status.pending)")
                    if let error = environment.status.lastError {
                        Text(error).foregroundStyle(Paper.warn)
                    }
                } header: {
                    Eyebrow("Zuletzt")
                }

                Section {
                    LabeledContent("Gesendet", value: "\(environment.status.report.pushed)")
                    LabeledContent("Übernommen", value: "\(environment.status.report.applied)")
                    LabeledContent("Verworfen", value: "\(environment.status.report.skipped)")
                    LabeledContent("Fehler", value: "\(environment.status.report.failed)")
                } header: {
                    Eyebrow("Letzter Stapel")
                }

                // The reasons, verbatim. A row that will not sync is otherwise
                // impossible to explain from the phone.
                if !environment.status.report.notes.isEmpty {
                    Section {
                        ForEach(environment.status.report.notes, id: \.self) { note in
                            Text(note).font(.caption).foregroundStyle(Paper.muted)
                        }
                    } header: {
                        Eyebrow("Hinweise")
                    }
                }

                Section {
                    Button("Jetzt abgleichen") { Task { await environment.sync() } }
                    Button("Kopplung lösen", role: .destructive) { environment.unpair() }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Paper.paper)
            .navigationTitle("Abgleich")
            .paperChrome()
        }
    }

    private var route: String {
        switch environment.status.route {
        case .lan: "WLAN"
        case .iCloud: "iCloud"
        case .none: "keiner"
        }
    }
}
