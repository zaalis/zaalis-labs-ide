import AVFoundation
import Foundation
import Speech

final class SpeechTranscriber {
    private let audioEngine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    init?(language: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            emit(["status": "error", "error": "recognizer-unavailable"])
            return nil
        }
        self.recognizer = recognizer
    }

    func start() {
        requestMicrophoneAccess { microphoneAllowed in
            guard microphoneAllowed else {
                emit(["status": "error", "error": "microphone-denied"])
                exit(2)
            }

            SFSpeechRecognizer.requestAuthorization { speechStatus in
                guard speechStatus == .authorized else {
                    emit(["status": "error", "error": "speech-denied"])
                    exit(3)
                }

                DispatchQueue.main.async {
                    do {
                        try self.startRecognition()
                    } catch {
                        emit(["status": "error", "error": String(describing: error)])
                        exit(4)
                    }
                }
            }
        }
    }

    func stop() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()
        task?.cancel()
        emit(["status": "end"])
    }

    private func startRecognition() throws {
        let inputNode = audioEngine.inputNode
        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        self.request = recognitionRequest

        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
        emit(["status": "ready"])

        task = recognizer.recognitionTask(with: recognitionRequest) { result, error in
            if let result = result {
                emit([
                    "status": "transcript",
                    "text": result.bestTranscription.formattedString,
                    "final": result.isFinal
                ])
            }

            if let error = error {
                emit(["status": "error", "error": String(describing: error)])
                self.stop()
                exit(5)
            }
        }
    }
}

// Transcrit un WAV déjà capturé par zaalis Browser. Cela évite de dépendre de
// whisper.cpp/Homebrew : l'application utilise le service Speech intégré à
// macOS, avec la même autorisation utilisateur que la dictée de l'IDE.
final class FileSpeechTranscriber {
    private let recognizer: SFSpeechRecognizer
    private var task: SFSpeechRecognitionTask?

    init?(language: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            emit(["status": "error", "error": "recognizer-unavailable"])
            return nil
        }
        self.recognizer = recognizer
    }

    func start(filePath: String) {
        guard FileManager.default.fileExists(atPath: filePath) else {
            emit(["status": "error", "error": "audio-file-missing"])
            exit(2)
        }

        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                emit(["status": "error", "error": "speech-denied"])
                exit(3)
            }

            DispatchQueue.main.async {
                let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: filePath))
                request.shouldReportPartialResults = false
                self.task = self.recognizer.recognitionTask(with: request) { result, error in
                    if let result = result {
                        emit([
                            "status": "transcript",
                            "text": result.bestTranscription.formattedString,
                            "final": result.isFinal
                        ])
                        if result.isFinal { exit(0) }
                    }
                    if let error = error {
                        emit(["status": "error", "error": String(describing: error)])
                        exit(4)
                    }
                }
            }
        }
    }
}

private func requestMicrophoneAccess(_ completion: @escaping (Bool) -> Void) {
    if #available(macOS 14.0, *) {
        AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
        return
    }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        completion(true)
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
    default:
        completion(false)
    }
}

private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else {
        return
    }
    print(line)
    fflush(stdout)
}

let arguments = Array(CommandLine.arguments.dropFirst())
func optionValue(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
    return arguments[index + 1]
}

if let filePath = optionValue("--file") {
    let language = optionValue("--language") ?? "fr-FR"
    guard let transcriber = FileSpeechTranscriber(language: language) else { exit(1) }
    transcriber.start(filePath: filePath)
    RunLoop.main.run()
} else {
    let language = arguments.first ?? "fr-FR"
    guard let transcriber = SpeechTranscriber(language: language) else { exit(1) }

    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "stop" {
                DispatchQueue.main.async {
                    transcriber.stop()
                    exit(0)
                }
                break
            }
        }
    }

    transcriber.start()
    RunLoop.main.run()
}
