from flask import Flask, render_template


def create_app():
    app = Flask(__name__)

    from . import auth
    app.register_blueprint(auth.bp)

    @app.route('/')
    def index():
        title = 'Flask fixture'
        return render_template('index.html', title=title)

    @app.route('/hello/<name>')
    def hello(name):
        return f'Hello {name}'

    return app
