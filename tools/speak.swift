import AVFoundation
import Foundation

// Usage: speak <text>
// Speaks the text using Jamie Premium voice.
// Blocks until speech finishes, then exits 0.
// Exits immediately if stdin closes (parent died) or SIGTERM received.

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: speak <text>\n", stderr)
    exit(1)
}

let text = CommandLine.arguments.dropFirst().joined(separator: " ")
guard !text.isEmpty else { exit(0) }

let synth = AVSpeechSynthesizer()

class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        exit(0)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        exit(0)
    }
}

let delegate = SpeakDelegate()
synth.delegate = delegate

// Handle SIGTERM — stop speaking and exit
signal(SIGTERM) { _ in
    synth.stopSpeaking(at: .immediate)
    _exit(0)
}
signal(SIGINT) { _ in
    synth.stopSpeaking(at: .immediate)
    _exit(0)
}

// Watch for parent death — if stdin closes, stop speaking
DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    synth.stopSpeaking(at: .immediate)
    _exit(0)
}

let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
let voice = voices.first(where: { $0.name.hasPrefix("Jamie") && $0.quality == .premium })
    ?? voices.first(where: { $0.name.hasPrefix("Jamie") && $0.quality == .enhanced })
    ?? voices.first(where: { $0.quality == .premium })
    ?? voices.first(where: { $0.quality == .enhanced })

let utterance = AVSpeechUtterance(string: text)
utterance.voice = voice
utterance.rate = 0.48
synth.speak(utterance)

RunLoop.main.run()
