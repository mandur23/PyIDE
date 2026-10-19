def shout(text):
    return text.upper() + '!'


def whisper(text):
    if not text:
        return ''
    return text.lower() + '...'
