# Chatinterface Agent Docker Sandbox
# Based on python:3.12-slim-bookworm with Node.js 20, Playwright, document tools

FROM python:3.12-slim-bookworm

LABEL maintainer="chatinterface" \
      description="Isolated execution environment for Chatinterface Agent" \
      version="1.0.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# ── Base system dependencies ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    libc6 libgcc-s1 libicu72 liblttng-ust1 libssl3 libstdc++6 libunwind8 zlib1g \
    libreoffice-writer libreoffice-impress \
    fonts-liberation fonts-noto fonts-noto-cjk \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 \
    git wget unzip pandoc \
    supervisor gosu \
    acl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── .NET 8 SDK ────────────────────────────────────────────────────────────────
# Microsoft packages are not in Debian repos; use the official install script.
RUN curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin \
    --channel 8.0 \
    --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet

# ── Non-root user ─────────────────────────────────────────────────────────────
# SECURITY: the application code under /app MUST stay root-owned and read-only
# for the runtime user. If the sandbox user could write /app/lib, a compromised
# session could patch sandbox_server.py / python_exec.py and backdoor every
# subsequent request handled by the same worker. Only /workspace and the
# Playwright browser cache are writable by the sandbox user.
RUN groupadd -r sandbox -g 1001 \
    && useradd -r -g sandbox -u 1001 -m -s /bin/bash sandbox \
    && mkdir -p /workspace /app/skills /app/scripts /app/lib \
    && chown -R sandbox:sandbox /workspace /ms-playwright 2>/dev/null || true

# ── Python packages ───────────────────────────────────────────────────────────
RUN pip install --no-cache-dir \
    jupyter ipython ipykernel \
    python-docx docxtpl python-pptx openpyxl lxml \
    pikepdf pdfplumber weasyprint \
    Pillow matplotlib opencv-python \
    numpy pandas scipy \
    scikit-learn sqlalchemy statsmodels \
    requests beautifulsoup4 \
    plotly seaborn altair \
    kaleido==0.2.1 vl-convert-python \
    flask gunicorn dill \
    playwright

# ── Playwright browsers & deps ────────────────────────────────────────────────
RUN npx playwright install chromium \
    && npx playwright install-deps chromium \
    && chown -R sandbox:sandbox /ms-playwright

# ── Application code ──────────────────────────────────────────────────────────
# SECURITY: copied as root:root and made non-writable (dirs 0755, files 0644,
# entrypoint.sh executable). The sandbox runtime user can read/import these but
# cannot modify them, so a session cannot backdoor the API server itself.
WORKDIR /app

COPY app/lib/ /app/lib/
COPY app/scripts/ /app/scripts/
COPY entrypoint.sh /app/entrypoint.sh
COPY supervisord.conf /app/supervisord.conf

RUN chmod 0755 /app /app/lib /app/scripts \
    && find /app/lib /app/scripts -type d -exec chmod 0755 {} + \
    && find /app/lib /app/scripts -type f -exec chmod 0644 {} + \
    && chmod 0755 /app/entrypoint.sh \
    && chmod 0644 /app/supervisord.conf

RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace && chmod 0750 /workspace

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health', timeout=5)" || exit 1

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
