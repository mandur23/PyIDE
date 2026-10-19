from django import template

register = template.Library()


@register.filter
def shout(value):
    return f'{value}!'.upper()


@register.simple_tag
def poll_count():
    return 3
