import Foundation
import Speech

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: transcribe <path-to-wav>\n", stderr)
    exit(1)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])

guard FileManager.default.fileExists(atPath: url.path) else {
    fputs("File not found: \(url.path)\n", stderr)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition not authorized (status: \(status.rawValue))\n", stderr)
        exit(1)
    }
    semaphore.signal()
}
semaphore.wait()

guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
    fputs("Speech recognizer unavailable\n", stderr)
    exit(1)
}

let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = false

recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
        fputs("Recognition error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    guard let result = result, result.isFinal else { return }
    print(result.bestTranscription.formattedString)
    exit(0)
}

RunLoop.main.run()
