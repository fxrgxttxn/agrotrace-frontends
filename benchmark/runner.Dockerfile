FROM python:3.12-slim

WORKDIR /bench

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# benchmark/ is bind-mounted over this at runtime (docker-compose.yml), so code edits never need
# a rebuild — only a requirements.txt change does. Baked in here too so the image is self
# contained (e.g. for `docker compose build` without the mount).
COPY . .

CMD ["python", "-m", "agrobench.env"]
