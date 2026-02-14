#!/bin/bash

PYTHON_VERSION=3.11

if [ -z `which python$PYTHON_VERSION` ]
then
    brew install python@$PYTHON_VERSION
fi
if [ ! -d .venv ]
then
    python3.11 -m venv .venv
fi

source .venv/bin/activate

if [ -z `which mlx_lm` ]
then
    pip install -U mlx-lm
fi

if [ -z `which mlx-openai-server` ]
then
    pip install git+https://github.com/cubist38/mlx-openai-server.git
fi

export MODEL_NAME=mlx-community/Qwen3-4B-Instruct-2507-8bit
#export MODEL_NAME=mlx-community/Meta-Llama-3.1-8B-Instruct-4bit

mlx-openai-server launch $DEBUG_LEVEL --host 127.0.0.1 --port 8000 --model-path $MODEL_NAME --no-log-file --model-type lm --max-concurrency 1 --queue-timeout 300 --queue-size 100 --tool-call-parser qwen3 --reasoning-parser qwen3
