#!/usr/bin/env python3
"""
Convert nterm-qt JSON session export to nterm-js YAML format.

Usage:
    python convert_sessions.py nterm_sessions.json
    python convert_sessions.py nterm_sessions.json -o sessions.yaml
"""

import json
import sys
import argparse
from pathlib import Path


def convert(input_path: str, output_path: str | None = None) -> str:
    with open(input_path) as f:
        data = json.load(f)

    # Build folder lookup
    folders = {f["id"]: f["name"] for f in data.get("folders", [])}

    # Group sessions by folder, preserving position order
    grouped: dict[str, list] = {}
    for s in data.get("sessions", []):
        folder_name = folders.get(s.get("folder_id"), "Ungrouped")
        grouped.setdefault(folder_name, []).append(s)

    for folder in grouped:
        grouped[folder].sort(key=lambda x: x.get("position", 0))

    # Build YAML
    lines = [
        "# nterm-js sessions",
        f"# Converted from: {Path(input_path).name}",
        "",
    ]

    for folder_name, sessions in grouped.items():
        lines.append(f"- folder_name: {folder_name}")
        lines.append("  sessions:")

        for s in sessions:
            lines.append(f"    - display_name: {s['name']}")
            lines.append(f"      host: {s['hostname']}")
            lines.append(f"      port: {s.get('port', 22)}")

            extras = s.get("extras", {})

            vendor = extras.get("vendor", "")
            if vendor:
                lines.append(f"      DeviceType: {vendor}")

            platform = extras.get("platform", "")
            if platform:
                lines.append(f"      platform: {platform}")

            desc = s.get("description", "")
            if desc:
                lines.append(f'      description: "{desc}"')

            cred = s.get("credential_name")
            if cred:
                lines.append(f"      credential_name: {cred}")

            lines.append("")

    output = "\n".join(lines)

    # Write or print
    if output_path:
        with open(output_path, "w") as f:
            f.write(output)
        print(f"Wrote {len(data.get('sessions', []))} sessions to {output_path}")
    else:
        # Default output name: same stem, .yaml extension
        out = Path(input_path).with_suffix(".yaml")
        with open(out, "w") as f:
            f.write(output)
        print(f"Wrote {len(data.get('sessions', []))} sessions to {out}")

    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert nterm-qt JSON session export to nterm-js YAML"
    )
    parser.add_argument("input", help="Path to nterm-qt JSON export file")
    parser.add_argument("-o", "--output", help="Output YAML path (default: same name, .yaml extension)")
    args = parser.parse_args()

    convert(args.input, args.output)