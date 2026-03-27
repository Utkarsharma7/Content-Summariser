FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY API/notebooklm-py /tmp/notebooklm-py
RUN pip install --no-cache-dir /tmp/notebooklm-py && rm -rf /tmp/notebooklm-py

COPY summariser_api.py .

EXPOSE 8000

CMD ["python", "summariser_api.py"]
