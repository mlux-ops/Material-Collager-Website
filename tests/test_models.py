import unittest
from pathlib import Path

from material_collager.models import (
    BACKGROUNDS,
    COLLAGE_TYPES,
    DEFAULT_SIZE_BY_ORIENTATION,
    ORIENTATIONS,
    QUALITIES,
    CollageItem,
    CollageRequest,
    ValidationError,
)
from test_helpers import workspace_tmp_dir


class CollageRequestTests(unittest.TestCase):
    def test_sunburst_defaults_and_quality_background_contract(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "appliance_collage",
                "items": [{"id": "fridge", "role": "appliance refrigerator", "image_paths": ["fridge.png"]}],
            }
        )

        self.assertEqual(request.quality, "high")
        self.assertEqual(request.resolved_background(), "opaque")
        self.assertEqual(QUALITIES, {"low", "medium", "high", "xhigh", "max", "auto"})
        self.assertEqual(BACKGROUNDS, {"opaque", "transparent"})

    def test_transparent_jpeg_is_rejected_before_generation(self):
        with self.assertRaisesRegex(ValidationError, "Transparent output requires PNG or WebP"):
            CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "background": "transparent",
                    "output_format": "jpeg",
                    "items": [{"id": "fridge", "role": "appliance refrigerator", "image_paths": ["fridge.png"]}],
                }
            )

    def test_transparent_webp_is_accepted(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "appliance_collage",
                "background": "transparent",
                "output_format": "webp",
                "items": [{"id": "fridge", "role": "appliance refrigerator", "image_paths": ["fridge.png"]}],
            }
        )
        self.assertEqual(request.resolved_background(), "transparent")

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

    def test_every_orientation_is_valid_for_every_collage_type(self):
        for collage_type in sorted(COLLAGE_TYPES):
            for orientation in sorted(ORIENTATIONS):
                with self.subTest(collage_type=collage_type, orientation=orientation):
                    request = CollageRequest.from_dict(
                        {
                            "collage_type": collage_type,
                            "orientation": orientation,
                            "items": [
                                {
                                    "id": "sample",
                                    "role": "wall tile",
                                    "image_paths": ["sample.png"],
                                }
                            ],
                        }
                    )

                    self.assertEqual(request.resolved_orientation(), orientation)
                    self.assertEqual(
                        request.resolved_size(),
                        DEFAULT_SIZE_BY_ORIENTATION[orientation],
                    )
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

    def test_direct_request_validation_rejects_unsupported_generation_contract(self):
        item = CollageItem(id="fridge", role="appliance refrigerator", image_paths=(Path("fridge.png"),))
        cases = [
            {"collage_type": "unknown_collage"},
            {"orientation": "diagonal"},
            {"quality": "ultra"},
            {"background": "checkerboard"},
            {"output_format": "gif"},
            {"background": "transparent", "output_format": "jpeg"},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                request_options = dict(overrides)
                collage_type = request_options.pop("collage_type", "appliance_collage")
                request = CollageRequest(collage_type=collage_type, items=(item,), **request_options)
                with self.assertRaises(ValidationError):
                    request.validate(check_paths=False)


if __name__ == "__main__":
    unittest.main()
