"""
Lokale Transkription mit faster-whisper.

Bewusst ohne Auth: der Container hängt nur im internen Docker-Netz und wird
ausschließlich vom Worker angesprochen. Der Port 8080 ist in docker-compose.yml
nur zum Debuggen nach außen gemappt — im produktiven Betrieb entfernen.
"""

import os
import tempfile
from functools import lru_cache

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "medium")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
DEFAULT_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "de")

app = FastAPI(title="soloops transcribe", version="0.1.0")


@lru_cache(maxsize=2)
def get_model(name: str) -> WhisperModel:
    # CPU + int8 läuft auf Apple Silicon und kleinen VPS zuverlässig.
    return WhisperModel(name, device="cpu", compute_type=COMPUTE_TYPE)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": DEFAULT_MODEL, "compute_type": COMPUTE_TYPE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(DEFAULT_LANGUAGE),
    model: str = Form(DEFAULT_MODEL),
) -> dict:
    suffix = os.path.splitext(file.filename or "audio")[1] or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        segments_iter, info = get_model(model).transcribe(
            tmp_path,
            language=None if language in ("", "auto") else language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
        )

        segments = [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments_iter
        ]
    except Exception as exc:  # noqa: BLE001 - Fehler an den Worker durchreichen
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        os.unlink(tmp_path)

    return {
        "language": info.language,
        "duration": info.duration,
        "text": " ".join(s["text"] for s in segments).strip(),
        "segments": segments,
    }
