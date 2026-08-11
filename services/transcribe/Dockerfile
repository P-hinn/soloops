FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Modelle liegen im Volume, damit ein Rebuild nicht neu herunterlädt
ENV HF_HOME=/models
ENV WHISPER_MODEL=medium
ENV WHISPER_COMPUTE_TYPE=int8
ENV WHISPER_LANGUAGE=de

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-keep-alive", "3600"]
