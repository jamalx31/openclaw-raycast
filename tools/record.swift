import AVFoundation
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: record <output.wav> <seconds>\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let seconds = Double(CommandLine.arguments[2]) ?? 8.0
let url = URL(fileURLWithPath: outputPath)

// Request mic permission
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
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

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

let recorder: AVAudioRecorder
do {
    recorder = try AVAudioRecorder(url: url, settings: settings)
} catch {
    fputs("Failed to create recorder: \(error.localizedDescription)\n", stderr)
    exit(1)
}

guard recorder.record(forDuration: seconds) else {
    fputs("Failed to start recording\n", stderr)
    exit(1)
}

let deadline = Date().addingTimeInterval(seconds + 1.0)
while recorder.isRecording && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
}

recorder.stop()
