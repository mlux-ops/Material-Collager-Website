import unittest
from pathlib import Path

from material_collager.models import CollageRequest, ValidationError
from test_helpers import workspace_tmp_dir


class CollageRequestTests(unittest.TestCase):
    def test_defaults_bathroom_tile_to_portrait_size(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "bathroom_tile_collage",
                "items": [
                    {
                        "id": "wall",
                        "role": "wall tile",
                        "image_paths": ["wall.png"],
                    }
                ],
            }
        )

        self.assertEqual(request.resolved_orientation(), "portrait")
        self.assertEqual(request.resolved_size(), "1024x1536")
        request.validate(check_paths=False)

    def test_rejects_square_for_non_fixture_collage(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "appliance_collage",
                "orientation": "square",
                "items": [
                    {
                        "id": "fridge",
                        "role": "appliance refrigerator",
                        "image_paths": ["fridge.png"],
                    }
                ],
            }
        )

        with self.assertRaises(ValidationError):
            request.validate(check_paths=False)

    def test_path_validation_accepts_existing_image_file(self):
        with workspace_tmp_dir() as tmp_path:
            path = tmp_path / "tile.png"
            path.write_bytes(b"not-real-image-but-extension-is-valid")
            request = CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "items": [
                        {
                            "id": "dishwasher",
                            "role": "appliance dishwasher",
                            "image_paths": [str(path)],
                        }
                    ],
                }
            )

            request.validate_paths()

    def test_path_validation_rejects_missing_file(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "appliance_collage",
                "items": [
                    {
                        "id": "dishwasher",
                        "role": "appliance dishwasher",
                        "image_paths": ["missing.png"],
                    }
                ],
            }
        )

        with self.assertRaises(ValidationError):
            request.validate_paths()

    def test_direct_request_rejects_empty_items(self):
        request = CollageRequest(collage_type="appliance_collage", items=())

        with self.assertRaises(ValidationError):
            request.validate(check_paths=False)


if __name__ == "__main__":
    unittest.main()
