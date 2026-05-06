"""
LLM API provider — abstracts Anthropic / OpenAI / OpenRouter API calls for task fulfillment.
"""
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


@dataclass
class LLMResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int


class LLMProvider:
    """Multi-provider LLM client for supplier agents."""

    def __init__(
        self,
        anthropic_api_key: str = "",
        openai_api_key: str = "",
        openrouter_api_key: str = "",
        default_model: str = "nvidia/nemotron-3-super-120b-a12b",
    ):
        self.anthropic_api_key = anthropic_api_key
        self.openai_api_key = openai_api_key
        self.openrouter_api_key = openrouter_api_key
        self.default_model = default_model
        self._anthropic_client = None
        self._openai_client = None
        self._openrouter_client = None

    def _get_anthropic_client(self):
        if self._anthropic_client is None and self.anthropic_api_key:
            import anthropic
            self._anthropic_client = anthropic.AsyncAnthropic(
                api_key=self.anthropic_api_key
            )
        return self._anthropic_client

    def _get_openai_client(self):
        if self._openai_client is None and self.openai_api_key:
            import openai
            self._openai_client = openai.AsyncOpenAI(api_key=self.openai_api_key)
        return self._openai_client

    def _get_openrouter_client(self):
        """OpenRouter uses the OpenAI-compatible API with a different base URL."""
        if self._openrouter_client is None and self.openrouter_api_key:
            import openai
            self._openrouter_client = openai.AsyncOpenAI(
                api_key=self.openrouter_api_key,
                base_url=OPENROUTER_BASE_URL,
            )
        return self._openrouter_client

    async def complete(
        self,
        prompt: str,
        model_preference: list[str] = None,
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> LLMResult:
        """Call the best available LLM based on preference list."""
        model_preference = model_preference or [self.default_model, "any"]
        model, provider = self._select_model(model_preference)

        if provider == "anthropic":
            return await self._call_anthropic(prompt, model, max_tokens, temperature)
        elif provider == "openrouter":
            return await self._call_openrouter(prompt, model, max_tokens, temperature)
        elif provider == "openai":
            return await self._call_openai(prompt, model, max_tokens, temperature)
        else:
            raise ValueError("No LLM API keys configured")

    def _select_model(self, preferences: list[str]) -> tuple[str, str]:
        """Select the best available model and provider from the preference list.
        Returns (model_id, provider)."""

        # OpenRouter model IDs use vendor/model format
        model_map = {
            "nemotron": ("nvidia/nemotron-3-super-120b-a12b", "nemotron-3-super"),
            "nemotron-super": ("nvidia/nemotron-3-super-120b-a12b", "nemotron-3-super"),
            "nemotron-nano": ("nvidia/nemotron-3-nano-30b-a3b", "nemotron-3-nano"),
            "claude-opus": ("anthropic/claude-opus-4-6", "claude-opus-4-6"),
            "claude-sonnet": ("anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"),
            "claude-haiku": ("anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"),
            "gpt-4": ("openai/gpt-4", "gpt-4"),
            "gpt-4o": ("openai/gpt-4o", "gpt-4o"),
        }

        for pref in preferences:
            if pref == "any":
                # Priority: OpenRouter > Anthropic > OpenAI
                if self.openrouter_api_key:
                    or_model = self._to_openrouter_model(self.default_model)
                    return (or_model, "openrouter")
                if self.anthropic_api_key:
                    return (self.default_model, "anthropic")
                if self.openai_api_key:
                    return ("gpt-4o", "openai")
                break

            if pref in model_map:
                or_id, native_id = model_map[pref]

                # Try OpenRouter first (it supports all models)
                if self.openrouter_api_key:
                    return (or_id, "openrouter")
                # Then try native APIs
                if native_id.startswith("claude") and self.anthropic_api_key:
                    return (native_id, "anthropic")
                if native_id.startswith("gpt") and self.openai_api_key:
                    return (native_id, "openai")

        # Last resort fallback
        if self.openrouter_api_key:
            return (self._to_openrouter_model(self.default_model), "openrouter")
        if self.anthropic_api_key:
            return (self.default_model, "anthropic")
        if self.openai_api_key:
            return ("gpt-4o", "openai")
        raise ValueError("No LLM API keys configured")

    def _to_openrouter_model(self, model: str) -> str:
        """Convert a native model name to OpenRouter format."""
        if "/" in model:
            return model
        if model.startswith("nemotron"):
            return f"nvidia/{model}"
        if model.startswith("claude"):
            return f"anthropic/{model}"
        if model.startswith("gpt"):
            return f"openai/{model}"
        return model

    async def _call_anthropic(
        self, prompt: str, model: str, max_tokens: int, temperature: float
    ) -> LLMResult:
        client = self._get_anthropic_client()
        if not client:
            raise ValueError("Anthropic API key not configured")

        response = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
        )

        text = response.content[0].text if response.content else ""
        return LLMResult(
            text=text,
            model=model,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )

    async def _call_openai(
        self, prompt: str, model: str, max_tokens: int, temperature: float
    ) -> LLMResult:
        client = self._get_openai_client()
        if not client:
            raise ValueError("OpenAI API key not configured")

        response = await client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
        )

        choice = response.choices[0] if response.choices else None
        text = choice.message.content if choice else ""
        return LLMResult(
            text=text,
            model=model,
            input_tokens=response.usage.prompt_tokens if response.usage else 0,
            output_tokens=response.usage.completion_tokens if response.usage else 0,
        )

    async def _call_openrouter(
        self, prompt: str, model: str, max_tokens: int, temperature: float
    ) -> LLMResult:
        """Call LLM via OpenRouter (OpenAI-compatible API)."""
        client = self._get_openrouter_client()
        if not client:
            raise ValueError("OpenRouter API key not configured")

        response = await client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
            extra_headers={
                "HTTP-Referer": "https://vector.apexfusion.org",
                "X-Title": "Vector AI Compute Network",
            },
        )

        choice = response.choices[0] if response.choices else None
        text = choice.message.content if choice else ""
        return LLMResult(
            text=text,
            model=model,
            input_tokens=response.usage.prompt_tokens if response.usage else 0,
            output_tokens=response.usage.completion_tokens if response.usage else 0,
        )
