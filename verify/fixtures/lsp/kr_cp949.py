# -*- coding: cp949 -*-
# 한글 인사
from models import make_greeter

print(make_greeter("kr").greet("kr"))  # 인사
