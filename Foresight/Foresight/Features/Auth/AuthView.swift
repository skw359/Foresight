//
//  AuthView.swift
//  Foresight
//
//  Register + Login. A SINGLE identifier field (email or username, user's
//  choice) and a password with no complexity rules — matches the contract.
//
//  Visual: a 1:1 port of Journey's WelcomeScreen — typewriter welcome headline
//  ("Welcome to Foresight." → tagline) with a compact bottom panel (icon +
//  title header, 300pt-wide column, hairline outline buttons, muted footer
//  text) and a full-screen spinner while submitting. The panel opens on a
//  Login / Register choice; picking one crossfades the panel content into
//  that form. Foresight-specific: the settings gear stays at the top.
//

import SwiftUI
import UIKit

struct AuthView: View {
    @EnvironmentObject private var session: Session

    /// Panel state: the initial two-option choice, or one of the two forms.
    private enum Step { case choice, login, register }

    @State private var step: Step = .choice
    @State private var identifier = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var showSettings = false

    @State private var displayedText = ""
    @State private var textOpacity = 0.0
    @State private var yOffset: CGFloat = 20
    @State private var panelShown = false
    @State private var hasStartedTypingAnimation = false
    @State private var typingAnimationCompleted = false

    private enum AnimationPhase {
        case typingBrand      // "Welcome to Foresight."
        case deletingBrand    // deleting "Foresight."
        case typingTagline    // "the first-class home security platform."
        case done
    }
    @State private var phase: AnimationPhase = .typingBrand

    let welcomeTypingDuration: Double = 0.7
    let animationDuration: Double = 0.7
    let fadeDuration: Double = 0.7

    /// Crossfade used when the panel content switches between steps.
    private let stepFade: Animation = .easeInOut(duration: 0.25)

    private let baseText = "Welcome to "
    private let brandWord = "Foresight."
    private let tagline = "the first-class home security platform."
    // "first-class" starts at index 4, ends at index 15 (exclusive) in tagline
    private let firstClassRange = (4, 15)

    /// Journey's muted panel-text color.
    private let mutedText = Color(hex: "#3A3A3C")

    private var canSubmit: Bool {
        !identifier.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isSubmitting
    }

    private var textSegments: [(String, Color)] {
        switch phase {
        case .typingBrand, .deletingBrand:
            // displayedText may be partial through "Welcome to " or into "Foresight."
            let len = displayedText.count
            let baselen = baseText.count
            if len <= baselen {
                return displayedText.isEmpty ? [] : [(displayedText, .white)]
            }
            let brandPart = String(displayedText.dropFirst(baselen))
            return [(baseText, .white), (brandPart, Theme.accent)]

        case .typingTagline, .done:
            let taglinePart = String(displayedText.dropFirst(baseText.count))
            return [(baseText, .white)] + taglineSegments(typed: taglinePart)

        }
    }

    private func taglineSegments(typed: String) -> [(String, Color)] {
        // tagline = "the first-class home security platform."
        let lo = firstClassRange.0
        let hi = firstClassRange.1
        let len = typed.count

        var segments: [(String, Color)] = []

        if len <= lo {
            segments.append((typed, .white))
        } else if len <= hi {
            let before = String(typed.prefix(lo))
            let colored = String(typed.dropFirst(lo))
            if !before.isEmpty { segments.append((before, .white)) }
            if !colored.isEmpty { segments.append((colored, Theme.accent)) }
        } else {
            let before = String(typed.prefix(lo))
            let colored = String(typed.prefix(hi).dropFirst(lo))
            let after = String(typed.dropFirst(hi))
            if !before.isEmpty { segments.append((before, .white)) }
            if !colored.isEmpty { segments.append((colored, Theme.accent)) }
            if !after.isEmpty { segments.append((after, .white)) }
        }

        return segments
    }

    var body: some View {
        ZStack {
            GeometryReader { geometry in
                let height = geometry.size.height
                // Journey anchors the panel at height / 1.4. The choice step fits
                // there exactly; the taller forms get a floor so the fields,
                // button, and footer stay on screen.
                let panelTopWhenShown = step == .choice
                    ? height / 1.4
                    : min(height / 1.4, height - 300)
                let panelOffset = panelShown ? panelTopWhenShown : height + 10

                ZStack {
                    if isSubmitting {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .tint(Theme.accent)
                            .scaleEffect(1.4)
                    } else {
                        VStack {
                            Spacer()

                            textSegments
                                .reduce(Text("")) { result, segment in
                                    result + Text(segment.0)
                                        .foregroundColor(segment.1)
                                }
                                .font(.montserrat(size: 30, weight: .bold))
                                .padding()
                                .opacity(textOpacity)
                                .offset(y: yOffset)
                                .animation(.easeOut(duration: fadeDuration), value: textOpacity)
                                .animation(.easeOut(duration: fadeDuration), value: yOffset)

                            Spacer()
                        }
                        .padding(.bottom, max(0, height - panelOffset))
                        .animation(.spring(), value: panelShown)

                        formPanel
                            .offset(y: panelOffset)
                            .animation(.spring(), value: panelShown)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background)
            }
            // Full-bleed like Journey's .edgesIgnoringSafeArea(.all); container
            // regions only so keyboard avoidance keeps the fields visible.
            .ignoresSafeArea(.container)

            settingsOverlay
        }
        .onAppear {
            startTypingAnimationIfNeeded()
            if !typingAnimationCompleted {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    panelShown = true
                }
            }
        }
        .onChange(of: identifier) { _, _ in errorMessage = nil }
        .onChange(of: password) { _, _ in errorMessage = nil }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    // MARK: - Panel

    private var formPanel: some View {
        VStack(spacing: 16) {
            if step == .choice {
                choiceContent
                    .transition(.opacity)
            } else {
                formContent
                    .transition(.opacity)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 20)
        .background(
            RoundedRectangle(cornerRadius: 30)
                .fill(Color.black.opacity(0.8))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30)
                .stroke(Theme.accent, lineWidth: 1)
        )
        .cornerRadius(30)
    }

    /// Initial state: the two entry options, in Journey's outline-button idiom.
    private var choiceContent: some View {
        VStack(spacing: 16) {
            panelHeader(title: "Get Started")

            panelButton("Login") {
                withAnimation(stepFade) { step = .login }
            }

            panelButton("Register") {
                withAnimation(stepFade) { step = .register }
            }
        }
    }

    /// Login / Register form. The two modes share this block so switching via
    /// the footer keeps whatever was already typed.
    private var formContent: some View {
        VStack(spacing: 16) {
            panelHeader(title: step == .login ? "Log In to Foresight" : "Create Your Account")

            ThemedField(placeholder: "Email or username", text: $identifier)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .frame(width: 300)

            ThemedField(placeholder: "Password", text: $password, isSecure: true)
                .textContentType(step == .register ? .newPassword : .password)
                .submitLabel(.go)
                .onSubmit { submit() }
                .frame(width: 300)

            panelButton(step == .login ? "Log In" : "Create Account") {
                submit()
            }
            .disabled(!canSubmit)
            .opacity(canSubmit ? 1 : 0.5)

            footerSlot
        }
    }

    private func panelHeader(title: String) -> some View {
        HStack {
            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(width: 20, height: 20)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            Text(title)
                .font(.montserrat(size: 17, weight: .bold))
                .foregroundColor(.white)
        }
    }

    /// Journey's outline action button ("Scan QR Code" idiom).
    private func panelButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.montserrat(size: 17, weight: .bold))
                .foregroundColor(.white)
                .padding()
                .frame(width: 300)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.fieldBorder, lineWidth: 2)
                )
        }
        .buttonStyle(.plain)
    }

    /// Journey's muted helper-text slot: shows the submit error when present,
    /// otherwise the login/register mode switch.
    @ViewBuilder
    private var footerSlot: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.montserrat(size: 14, weight: .bold))
                .foregroundColor(Theme.redAction)
                .frame(width: 300)
                .multilineTextAlignment(.center)
        } else {
            Button {
                withAnimation(stepFade) {
                    step = step == .login ? .register : .login
                }
            } label: {
                (
                    Text(step == .login ? "New to Foresight? " : "Already have an account? ")
                        .foregroundColor(mutedText)
                    + Text(step == .login ? "Create an account." : "Log in.")
                        .foregroundColor(Theme.accent)
                )
                .font(.montserrat(size: 14, weight: .bold))
                .frame(width: 300)
                .multilineTextAlignment(.center)
            }
            .buttonStyle(.plain)
        }
    }

    private var settingsOverlay: some View {
        VStack {
            HStack {
                Spacer()
                GlassCircleButton(
                    systemName: "gearshape",
                    accessibilityText: "Server settings"
                ) {
                    showSettings = true
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer()
        }
    }

    // MARK: - Animation Steps

    private func startTypingAnimationIfNeeded() {
        guard !hasStartedTypingAnimation else { return }
        hasStartedTypingAnimation = true

        Task {
            await runTypingAnimation()
        }
    }

    @MainActor
    private func runTypingAnimation() async {
        displayedText = ""
        phase = .typingBrand
        let typingFeedbackGenerator = UISelectionFeedbackGenerator()
        typingFeedbackGenerator.prepare()

        withAnimation {
            textOpacity = 1.0
            yOffset = 0
        }

        await appendText(
            baseText + brandWord,
            duration: welcomeTypingDuration,
            feedbackGenerator: typingFeedbackGenerator
        )

        guard !(await sleep(seconds: 1.5)) else { return }
        await deleteBrandWord()
    }

    @MainActor
    private func deleteBrandWord() async {
        phase = .deletingBrand
        let deleteInterval = animationDuration / Double(max(brandWord.count, 1))

        while displayedText.count > baseText.count {
            displayedText.removeLast()

            if await sleep(seconds: deleteInterval) {
                return
            }
        }

        await typeTagline()
    }

    @MainActor
    private func typeTagline() async {
        phase = .typingTagline
        await appendText(tagline, duration: 2.0)
        phase = .done
        typingAnimationCompleted = true
    }

    @MainActor
    private func appendText(
        _ text: String,
        duration: Double,
        feedbackGenerator: UISelectionFeedbackGenerator? = nil
    ) async {
        let characters = Array(text)
        let interval = duration / Double(max(characters.count, 1))

        for character in characters {
            displayedText.append(character)
            if character.isLetter {
                feedbackGenerator?.selectionChanged()
                feedbackGenerator?.prepare()
            }

            if await sleep(seconds: interval) {
                return
            }
        }
    }

    private func sleep(seconds: Double) async -> Bool {
        guard seconds > 0 else { return false }

        do {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return false
        } catch {
            return true
        }
    }

    // MARK: - Submit

    private func submit() {
        guard canSubmit else { return }
        errorMessage = nil
        isSubmitting = true
        let id = identifier.trimmingCharacters(in: .whitespaces)
        let pw = password
        let isLogin = step == .login
        Task {
            do {
                let response: AuthResponse = isLogin
                    ? try await session.api.login(identifier: id, password: pw)
                    : try await session.api.register(identifier: id, password: pw)
                // Pass the just-typed password so the session can unlock the
                // E2EE key vault (or run first-login key generation).
                await session.handleAuthSuccess(response, password: pw)
            } catch {
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
            isSubmitting = false
        }
    }
}
