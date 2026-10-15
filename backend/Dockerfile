FROM python:3.11-slim

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 构建缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# 开发模式启动（--reload），生产环境去掉该参数
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
