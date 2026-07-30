#!/usr/bin/env python3

import json
import os
import urllib.request

base_url = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
api_key = os.environ.get("OPENAI_API_KEY")
if not base_url or not api_key:
    raise RuntimeError("Set OPENAI_BASE_URL and OPENAI_API_KEY")

payload = json.dumps({
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Reply with exactly HELLO."}],
    "stream": False,
}).encode("utf-8")

request = urllib.request.Request(
    f"{base_url}/chat/completions",
    data=payload,
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    method="POST",
)

with urllib.request.urlopen(request, timeout=90) as response:
    completion = json.load(response)
    print(completion["choices"][0]["message"]["content"])
