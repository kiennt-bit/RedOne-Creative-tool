# RedOne Hub — container image. Runs identically on any Docker host
# (your external trial box now, the company server later).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# psycopg2-binary + boto3 ship wheels, so slim needs no extra build tools.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
RUN mkdir -p /app/media

EXPOSE 8800

# Mark unhealthy if /health stops responding.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8800/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8800", "--workers", "4"]
