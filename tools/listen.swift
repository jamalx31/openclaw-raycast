import AVFoundation
import Foundation
import Speech

// Usage: listen [max-seconds]
// Records from mic with live transcription. Stops after a silence gap once
// speech is detected, or after max-seconds (default 30).
//
// Output on stdout:
//   partial:<text>   — interim results
//   final:<text>     — done

let maxSeconds = Double(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "30") ?? 30.0
let silenceTimeout: Double = 2.0  // seconds of silence after speech to auto-stop

// -- Permissions ----------------------------------------------------------

let speechSem = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition not authorized (status: \(status.rawValue))\n", stderr)
        exit(1)
    }
    speechSem.signal()
}
speechSem.wait()

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized: break
case .notDetermined:
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
    sem.wait()
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        fputs("Microphone access denied\n", stderr)
        exit(1)
    }
case .denied, .restricted:
    fputs("Microphone access denied — grant access in System Settings > Privacy > Microphone\n", stderr)
    exit(1)
@unknown default:
    fputs("Unknown microphone authorization status\n", stderr)
    exit(1)
}

// -- Recognizer -----------------------------------------------------------

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
      recognizer.isAvailable else {
    fputs("Speech recognizer unavailable\n", stderr)
    exit(1)
}

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let format = inputNode.outputFormat(forBus: 0)

var lastNonEmpty = ""
var finished = false
var heardSpeech = false
var silenceTimer: DispatchWorkItem?
var activeRequest: SFSpeechAudioBufferRecognitionRequest?
var activeTask: SFSpeechRecognitionTask?

func finish() {
    guard !finished else { return }
    finished = true
    silenceTimer?.cancel()
    engine.stop()
    inputNode.removeTap(onBus: 0)
    activeRequest?.endAudio()
    activeTask?.cancel()

    if !lastNonEmpty.isEmpty {
        print("final:\(lastNonEmpty)")
        fflush(stdout)
        exit(0)
    } else {
        fputs("No speech detected\n", stderr)
        exit(1)
    }
}

func resetSilenceTimer() {
    silenceTimer?.cancel()
    guard heardSpeech else { return }
    let item = DispatchWorkItem { finish() }
    silenceTimer = item
    DispatchQueue.main.asyncAfter(deadline: .now() + silenceTimeout, execute: item)
}

// Tap feeds audio buffers to whichever request is active
inputNode.removeTap(onBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    activeRequest?.append(buffer)
}

engine.prepare()
do {
    try engine.start()
} catch {
    fputs("Audio engine failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

// -- Recognition (restarts on early isFinal to keep listening) ------------

func startRecognition() {
    guard !finished else { return }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    activeRequest = request

    activeTask = recognizer.recognitionTask(with: request) { result, error in
        guard !finished else { return }

        if let result {
            let text = result.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines)

            if !text.isEmpty {
                heardSpeech = true
                lastNonEmpty = text
                print("partial:\(text)")
                fflush(stdout)
                resetSilenceTimer()
            }

            if result.isFinal && !finished {
                startRecognition()
            }
        } else if error != nil && !finished {
            startRecognition()
        }
    }
}

startRecognition()

// -- Signal handlers (allow parent to trigger clean stop) -----------------

signal(SIGTERM) { _ in DispatchQueue.main.async { finish() } }
signal(SIGINT)  { _ in DispatchQueue.main.async { finish() } }

// -- Hard deadline --------------------------------------------------------

DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds) {
    finish()
}

// -- Handle parent death (stdin close) ------------------------------------

DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    DispatchQueue.main.async { finish() }
}

RunLoop.main.run()
