FROM python:3.12.12-slim

RUN python -m pip install --no-cache-dir \
      fastmcp==4.0.11 \
      pypdf==5.9.0 \
      pytest==8.4.2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp

WORKDIR /workspace
USER 65532:65532
CMD ["sleep", "infinity"]
