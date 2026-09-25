# Base pinned by digest (python:3.12-slim, Python 3.12.14 — the version recorded in env.json for the
# published run; the digest the run itself pulled was not recorded, this is the tag's digest on
# 2026-09-25 with the same Python). Update deliberately, together with constraints.txt.
FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

WORKDIR /bench

COPY requirements.txt constraints.txt ./
# constraints.txt pins every transitive dependency too (pip freeze of the image the run used).
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt

# benchmark/ is bind-mounted over this at runtime (docker-compose.yml), so code edits never need
# a rebuild — only a requirements.txt change does. Baked in here too so the image is self
# contained (e.g. for `docker compose build` without the mount).
COPY . .

CMD ["python", "-m", "agrobench.env"]
