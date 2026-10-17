FROM rocm/pytorch:latest

# Keep the ROCm build of torch. Packages below do not depend on torch;
# the version check fails the image if a later install replaces it.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -c "import torch; assert '+rocm' in torch.__version__, torch.__version__"

WORKDIR /app
COPY cite.py daemon.py app.py ./
RUN mkdir -p /app/output \
    && python3 -c "import torch; assert '+rocm' in torch.__version__, torch.__version__"

ENV CITE_SOCKET=/tmp/colag-cite.sock
CMD ["python3", "/app/daemon.py"]
