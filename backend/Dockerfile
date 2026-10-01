# Backend only -- the frontend has its own Dockerfile in frontend/.
# python:3.13 (not 3.12): pyproject requires-python >= 3.13
FROM python:3.13-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

# Dependencies first, so this layer caches across code changes
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

EXPOSE 8000

CMD ["uv", "run", "--no-sync", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
