FROM python:3.12-slim

WORKDIR /app

# 🔥 ADD THIS BLOCK
RUN apt-get update && apt-get install -y \
    gcc \
    libcairo2-dev \
    pkg-config \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY API/notebooklm-py /tmp/notebooklm-py
RUN pip install --no-cache-dir /tmp/notebooklm-py && rm -rf /tmp/notebooklm-py

COPY summariser_api.py .

EXPOSE 8000

CMD ["python", "summariser_api.py"]