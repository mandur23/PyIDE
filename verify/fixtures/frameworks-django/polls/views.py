from django.shortcuts import get_object_or_404, render
from django.views import generic

from .models import Question


def index(request):
    latest = Question.objects.order_by('-pub_date')[:5]
    greeting = 'Hello from polls'
    return render(request, 'polls/index.html', {'latest': latest, 'greeting': greeting})


def detail(request, question_id):
    question = get_object_or_404(Question, pk=question_id)
    return render(request, 'polls/detail.html', {'question': question})


class ResultsView(generic.DetailView):
    model = Question
    template_name = 'polls/detail.html'
