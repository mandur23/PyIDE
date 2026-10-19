from flask import Blueprint, render_template

bp = Blueprint('auth', __name__, url_prefix='/auth')


@bp.route('/login', methods=['GET', 'POST'])
def login():
    return render_template('auth/login.html')


@bp.get('/logout')
def logout():
    return 'bye'
