import json
import io
import unittest
from contextlib import redirect_stdout

from material_collager.cli import main
from test_helpers import workspace_tmp_dir


class CliTests(unittest.TestCase):
    def test_dry_run_for_all_collage_types(self):
        cases = {
            "kitchen_material_palette": [
                "wood",
                "countertop",
                "faucet",
                "hardware",
                "flooring",
            ],
            "appliance_collage": ["appliance refrigerator"],
            "bathroom_fixture_collage": [
                "vanity faucet",
                "shower head",
                "valve trim",
                "hardware",
                "wood",
                "tile",
                "countertop",
            ],
            "bathroom_tile_collage": [
                "wall tile",
                "floor tile",
                "accent tile",
                "wood",
                "countertop",
                "metal",
            ],
        }

        with workspace_tmp_dir() as tmp_path:
            image = tmp_path / "ref.png"
            image.write_bytes(b"fake")

            for collage_type, roles in cases.items():
                request_path = tmp_path / f"{collage_type}.json"
                items = [
                    {
                        "id": f"item_{index}",
                        "role": role,
                        "image_paths": [str(image)],
                    }
                    for index, role in enumerate(roles)
                ]
                request_path.write_text(
                    json.dumps({"collage_type": collage_type, "items": items}),
                    encoding="utf-8",
                )

                with self.subTest(collage_type=collage_type):
                    with redirect_stdout(io.StringIO()):
                        self.assertEqual(main(["dry-run", "--input", str(request_path)]), 0)


if __name__ == "__main__":
    unittest.main()
