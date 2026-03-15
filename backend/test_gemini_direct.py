"""
Direct Gemini Live test — bypasses the FastAPI backend.
Sends a text message and waits for any response to confirm the receive loop works.
"""

import asyncio
import os
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options={"api_version": "v1beta"},
)

MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
SILENT_AUDIO_100MS = bytes(3200)  # 16kHz, 16-bit, mono, 100ms


def make_test_jpeg() -> bytes:
    from PIL import Image
    import io
    img = Image.new('RGB', (320, 240), color=(200, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=80)
    return buf.getvalue()


TRIGGER_EVENT_DECL = types.FunctionDeclaration(
    name="trigger_event",
    description="Call when you observe a game event.",
    parameters=types.Schema(
        type=types.Type.OBJECT,
        properties={
            "event_type": types.Schema(type=types.Type.STRING),
            "confidence": types.Schema(type=types.Type.NUMBER),
            "description": types.Schema(type=types.Type.STRING),
        },
        required=["event_type", "confidence", "description"],
    ),
)


async def main():
    print("=== Direct Gemini Live test ===")
    print(f"Model: {MODEL}")

    config = types.LiveConnectConfig(
        # No response_modalities — let model default, hoping to enable function calling
        system_instruction=types.Content(
            parts=[types.Part(text="You are a test assistant. ONLY use function calls to respond — never speak or write text. When you receive an image, immediately call trigger_event() with event_type='test', confidence=0.99, description='test image received'. Do not generate audio or text — only call the function.")]
        ),
        tools=[types.Tool(function_declarations=[TRIGGER_EVENT_DECL])],
    )

    jpeg = make_test_jpeg()

    async with client.aio.live.connect(model=MODEL, config=config) as session:
        print("✓ Connected to Gemini Live")

        # Step 1: Send a text message first
        print("\n[A] Sending text turn...")
        await session.send_client_content(
            turns=[types.Content(role="user", parts=[types.Part(text="Hello. Please call trigger_event() now.")])]
        )
        print("    Text sent ✓")

        # Step 2: Wait up to 10s for any response
        print("\n[B] Waiting for response (10s)...")
        try:
            async def collect():
                i = 0
                async for resp in session.receive():
                    i += 1
                    print(f"    recv #{i}: type={type(resp).__name__} tool_call={resp.tool_call} text={getattr(resp, 'text', None)}", flush=True)
                    if resp.tool_call:
                        print("    ✅ Got tool_call!")
                        return True
                    if i >= 5:
                        return False
            result = await asyncio.wait_for(collect(), timeout=15)
            print(f"    Done — got tool call: {result}")
        except asyncio.TimeoutError:
            print("    ⏱ Timeout — no response in 15s")

        # Step 3: Send audio + image
        print("\n[C] Sending silent audio + JPEG frame...")
        await session.send_realtime_input(
            audio=types.Blob(data=SILENT_AUDIO_100MS, mime_type="audio/pcm;rate=16000")
        )
        await session.send_realtime_input(
            media=types.Blob(data=jpeg, mime_type="image/jpeg")
        )
        print("    Frame sent ✓")

        # Step 4: Wait for response to frame
        print("\n[D] Waiting for response to frame (15s)...")
        try:
            async def collect2():
                i = 0
                async for resp in session.receive():
                    i += 1
                    print(f"    recv #{i}: tool_call={resp.tool_call} text={getattr(resp, 'text', None)}", flush=True)
                    if resp.tool_call:
                        print("    ✅ Got tool_call!")
                        return True
                    if i >= 5:
                        return False
            result = await asyncio.wait_for(collect2(), timeout=15)
            print(f"    Done — got tool call: {result}")
        except asyncio.TimeoutError:
            print("    ⏱ Timeout — no response in 15s")

    print("\n=== Done ===")


if __name__ == "__main__":
    asyncio.run(main())
