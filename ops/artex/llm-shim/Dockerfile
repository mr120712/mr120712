# ops/artex/llm-shim/Dockerfile — reasoning_content-stripping LLM reverse proxy.
# Pure stdlib; no pip deps, no network at build time.
FROM python:3.12-alpine
WORKDIR /app
COPY proxy.py /app/proxy.py
USER nobody
EXPOSE 8080
CMD ["python", "/app/proxy.py"]
