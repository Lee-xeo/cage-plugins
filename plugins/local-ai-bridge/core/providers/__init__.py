"""Built-in native CLI AI providers."""

from .antigravity import AntigravityProvider
from .base import AIProvider, ModelInfo, ProviderStatus, TaskHandle, TurnRequest, TurnResult
from .codex import CodexProvider
from .grok import GrokProvider


def create_default_providers() -> dict[str, AIProvider]:
    providers: list[AIProvider] = [
        CodexProvider(),
        GrokProvider(),
        AntigravityProvider(),
    ]
    return {p.id: p for p in providers}


__all__ = [
    "AIProvider",
    "AntigravityProvider",
    "CodexProvider",
    "GrokProvider",
    "ModelInfo",
    "ProviderStatus",
    "TaskHandle",
    "TurnRequest",
    "TurnResult",
    "create_default_providers",
]
