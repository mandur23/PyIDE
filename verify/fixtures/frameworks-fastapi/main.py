from fastapi import FastAPI

from routers import items

app = FastAPI()
app.include_router(items.router, prefix='/api')


@app.get('/')
async def root():
    return {'message': 'Hello World'}


@app.post('/echo')
async def echo(payload: dict):
    return payload
