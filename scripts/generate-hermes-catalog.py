"""Export public Hermes provider metadata; never export credentials or config values.

Run with the Python interpreter in the installed Hermes Agent venv. The output
is a fallback catalog for Zaalis when Hermes is updated or temporarily closed.
"""

import json
from pathlib import Path

from hermes_cli.models_catalog_static import _PROVIDER_MODELS
from hermes_cli.provider_catalog import provider_catalog


catalog = []
for provider in provider_catalog():
    catalog.append({
        "id": provider.slug,
        "label": provider.label,
        "authType": provider.auth_type,
        "tab": provider.tab,
        "keyEnv": provider.api_key_env_vars[0] if provider.api_key_env_vars else "",
        "models": list(_PROVIDER_MODELS.get(provider.slug, [])),
    })

destination = Path(__file__).resolve().parents[1] / "hermes-provider-catalog.json"
destination.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Exported {len(catalog)} Hermes providers to {destination}")
