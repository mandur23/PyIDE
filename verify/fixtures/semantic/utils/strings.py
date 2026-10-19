def reverse_words(sentence):
    return " ".join(reversed(sentence.split()))


def slugify(title):
    return "-".join(title.lower().split())
