from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_WEB = ROOT.parent / "web-funghi-index"


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str
    stderr: str


def run(command: list[str], cwd: Path) -> CommandResult:
    process = subprocess.run(
        command, cwd=cwd, text=True, encoding="utf-8", errors="replace",
        capture_output=True, check=False,
    )
    return CommandResult(process.returncode, process.stdout, process.stderr)


def npm_audit(component: str, directory: Path) -> tuple[set[str], dict[str, int]]:
    result = run(["npm.cmd" if sys.platform == "win32" else "npm", "audit", "--omit=dev", "--json"], directory)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{component} npm audit did not return JSON") from exc
    if result.code not in (0, 1) or payload.get("error"):
        raise RuntimeError(f"{component} npm audit failed")
    vulnerabilities = payload.get("vulnerabilities") or {}
    advisory_ids = extract_advisory_ids(payload)
    counts = ((payload.get("metadata") or {}).get("vulnerabilities") or {})
    return advisory_ids, {key: int(value) for key, value in counts.items() if isinstance(value, int)}


def extract_advisory_ids(payload: dict[str, Any]) -> set[str]:
    vulnerabilities = payload.get("vulnerabilities") or {}
    return {
        str(via.get("url", "")).rsplit("/", 1)[-1]
        for item in vulnerabilities.values()
        for via in item.get("via", [])
        if isinstance(via, dict) and str(via.get("url", "")).rsplit("/", 1)[-1].startswith("GHSA-")
    }


def allowed_advisories(policy_path: Path, component: str, today: date) -> set[str]:
    payload = json.loads(policy_path.read_text(encoding="utf-8"))
    allowed: set[str] = set()
    for item in payload.get("exceptions", []):
        if item.get("component") != component:
            continue
        expiry = date.fromisoformat(str(item["expires_on"]))
        if expiry < today:
            raise RuntimeError(f"{component} dependency exception expired")
        if not item.get("reason") or not item.get("owner"):
            raise RuntimeError(f"{component} dependency exception is incomplete")
        allowed.update(str(advisory) for advisory in item.get("advisories", []))
    return allowed


def write_npm_sbom(directory: Path, output: Path) -> None:
    command = ["npm.cmd" if sys.platform == "win32" else "npm", "sbom", "--sbom-format", "cyclonedx", "--omit", "dev"]
    result = run(command, directory)
    if result.code != 0:
        raise RuntimeError(f"npm SBOM failed for {directory.name}")
    json.loads(result.stdout)
    output.write_text(result.stdout, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Dependency audit gate and CycloneDX SBOM generator")
    parser.add_argument("--web-dir", type=Path, default=DEFAULT_WEB)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "backend" / "outputs" / "security")
    args = parser.parse_args()
    policy = ROOT / "security" / "dependency-exceptions.json"
    for required in (ROOT / "backend" / "uv.lock", ROOT / "mobile" / "package-lock.json", args.web_dir / "package-lock.json", policy):
        if not required.is_file():
            raise SystemExit(f"[DEPENDENCY GATE] missing={required.name}")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    for component, directory in (("mobile", ROOT / "mobile"), ("web", args.web_dir)):
        advisories, counts = npm_audit(component, directory)
        unexpected = advisories - allowed_advisories(policy, component, date.today())
        write_npm_sbom(directory, args.output_dir / f"{component}.cdx.json")
        print(f"[DEPENDENCY GATE] component={component} total={counts.get('total', 0)} unexpected={len(unexpected)}")
        if unexpected:
            failures.append(f"{component}:{','.join(sorted(unexpected))}")

    python_audit = run([
        "uv", "run", "--project", str(ROOT / "backend"), "--frozen", "pip-audit",
        "--progress-spinner", "off", "--format", "json"
    ], ROOT)
    try:
        python_payload: Any = json.loads(python_audit.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Python audit did not return JSON") from exc
    python_vulns = sum(len(item.get("vulns", [])) for item in python_payload.get("dependencies", []))
    print(f"[DEPENDENCY GATE] component=backend vulnerabilities={python_vulns}")
    if python_audit.code not in (0, 1) or python_vulns:
        failures.append(f"backend:{python_vulns}")

    sbom = run([
        "uv", "run", "--project", str(ROOT / "backend"), "--frozen", "pip-audit",
        "--progress-spinner", "off", "--format", "cyclonedx-json", "--output",
        str(args.output_dir / "backend.cdx.json")
    ], ROOT)
    if sbom.code not in (0, 1):
        raise RuntimeError("Python SBOM generation failed")
    backend_sbom = args.output_dir / "backend.cdx.json"
    if not backend_sbom.is_file():
        raise RuntimeError("Python SBOM was not created")
    json.loads(backend_sbom.read_text(encoding="utf-8"))
    if failures:
        raise SystemExit(f"[DEPENDENCY GATE] blocked={';'.join(failures)}")
    print(f"[DEPENDENCY GATE] ok sbom_dir={args.output_dir}")


if __name__ == "__main__":
    main()
