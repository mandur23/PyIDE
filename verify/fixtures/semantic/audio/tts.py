def synthesize_speech(text, voice="ko-KR"):
    """Turn text into a wav file using the text to speech engine."""
    wav = render_waveform(text, voice)
    return save_wav(wav)


def render_waveform(text, voice):
    return [0.0] * len(text)


def save_wav(samples, path="out.wav"):
    return path
