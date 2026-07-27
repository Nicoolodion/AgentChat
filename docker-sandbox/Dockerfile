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
    # libgomp1: OpenMP runtime — used by the CPU torch/opencv stacks pulled in
    # for the in-sandbox PP-OCRv6 OCR engine (paddleocr transformers engine).
    libgomp1 \
    libreoffice-writer libreoffice-impress \
    fonts-liberation fonts-noto fonts-noto-cjk \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender-dev \
    # WeasyPrint native deps: it loads libpango via ctypes. Without these the
    # pip-installed weasyprint fails to import ("cannot load library
    # 'libpangoft2-1.0-0'"), so the HTML->PDF fallback path was unusable.
    libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 libcairo2 libffi8 \
    git wget unzip tar gzip pandoc \
    # poppler-utils: provides pdftoppm for rasterizing PDFs in the OCR tool.
    poppler-utils \
    # git-lfs: the PP-OCRv6 safetensors weights are shipped via LFS in
    # docker-sandbox/app/models/ (the build host calls `git lfs pull` during
    # checkout). The runtime itself does not need lfs, but installing it here
    # keeps the toolchain self-contained for layered rebuilds.
    git-lfs \
    supervisor gosu \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── .NET 8 SDK ────────────────────────────────────────────────────────────────
# Required by the `docx` skill, which builds DOCX files via a C# + OpenXML SDK
# pipeline (skills/docx/scripts/docx runs `dotnet build` / `dotnet run`). The
# SDK is therefore intentionally kept despite the audit (C13); removing it
# would break DOCX generation. Microsoft packages are not in Debian repos; use
# the official install script.
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
# NOTE (C13): versions below are intentionally unpinned for now. For production
# reproducibility, pin every package to an exact version (preferably via a
# requirements.txt referenced here) and rebuild. --no-cache-dir keeps this
# layer small.
#
# torch + torchvision are installed first from the CPU-only wheel index so CUDA
# libs (which add ~3GB) are never pulled; they power the in-sandbox PP-OCRv6 OCR
# engine (paddleocr transformers engine) running purely on CPU. torchvision is
# required by the HuggingFace `AutoImageProcessor` the PaddleOCR preprocessor
# loads at pipeline init — without it the OCR bootstrap dies with
# "AutoImageProcessor requires the Torchvision library".
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision \
    && pip install --no-cache-dir \
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
    # reportlab: pure-Python PDF generation, kept as a reliable last-resort
    # fallback when LibreOffice/Playwright are unavailable. pypdf: read/inspect
    # the generated PDFs. Pre-installed so the agent doesn't waste a turn on
    # pip_install on every session.
    reportlab pypdf \
    # OCR engine stack: PP-OCRv6_medium (det + rec safetensors). The
    # transformers engine avoids needing the heavy paddlepaddle framework
    # entirely — only `transformers` + `torch` (CPU, above) are required to
    # run the baked-in safetensors weights under /app/models.
    paddleocr transformers \
    playwright

# ── Playwright browsers & deps ────────────────────────────────────────────────
# Drive browser install through the pip-installed `playwright` package itself,
# NOT `npx playwright`: npx fetches the npm `latest` tag, which can resolve to a
# version that does not exist on the registry (e.g. dist-tag glitch 1.61.1) and
# breaks the build. Using the pip package's CLI guarantees the browser build
# matches the installed driver version.
RUN python -m playwright install --with-deps chromium \
    && chown -R sandbox:sandbox /ms-playwright

# ── Application code ──────────────────────────────────────────────────────────
# SECURITY: copied as root:root and made non-writable (dirs 0755, files 0644,
# entrypoint.sh executable). The sandbox runtime user can read/import these but
# cannot modify them, so a session cannot backdoor the API server itself.
WORKDIR /app

COPY app/lib/ /app/lib/
COPY app/scripts/ /app/scripts/
# PP-OCRv6_medium detection + recognition safetensors, baked read-only into the
# image (tracked via Git LFS — see .gitattributes). No runtime download: the OCR
# bootstrap loads them straight from /app/models. Kept read-only for the
# runtime user (rootfs is read-only anyway), so a compromised session cannot
# tamper with the model weights.
COPY app/models/ /app/models/
COPY entrypoint.sh /app/entrypoint.sh
COPY supervisord.conf /app/supervisord.conf

RUN chmod 0755 /app /app/lib /app/scripts /app/models \
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
