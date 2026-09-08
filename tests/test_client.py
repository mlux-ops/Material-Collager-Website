import base64
import os
import unittest
from pathlib import Path

from material_collager.client import generate_collage
from material_collager.models import CollageItem, CollageRequest, ValidationError
from test_helpers import workspace_tmp_dir


class FakeImages:
    def __init__(self):
        self.last_kwargs = None

    def edit(self, **kwargs):
        self.last_kwargs = kwargs
        return type(
            "ImageResponse",
            (),
            {
                "data": [
                    type(
                        "ImageData",
                        (),
                        {"b64_json": base64.b64encode(b"image-bytes").decode("ascii")},
                    )()
                ],
                "usage": {"total_tokens": 1},
            },
        )()


class FakeClient:
    def __init__(self):
        self.images = FakeImages()


class ClientTests(unittest.TestCase):
    def test_generate_sends_all_reference_files_to_image_edit(self):
        with workspace_tmp_dir() as tmp_path:
            first = tmp_path / "first.png"
            second = tmp_path / "second.png"
            out = tmp_path / "out.png"
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            request = CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "items": [
                        {
                            "id": "fridge",
                            "role": "appliance refrigerator",
                            "image_paths": [str(first)],
                        },
                        {
                            "id": "dishwasher",
                            "role": "appliance dishwasher",
                            "image_paths": [str(second)],
                        },
                    ],
                }
            )
            client = FakeClient()

            result = generate_collage(request, client=client, output_path=out)

            self.assertEqual(out.read_bytes(), b"image-bytes")
            self.assertEqual(result.model, "gpt-image-2.5-sunburst")
            self.assertEqual(client.images.last_kwargs["model"], "gpt-image-2.5-sunburst")
            self.assertEqual(client.images.last_kwargs["size"], "1536x1024")
            self.assertEqual(client.images.last_kwargs["quality"], "high")
            self.assertEqual(client.images.last_kwargs["background"], "opaque")
            self.assertEqual(len(client.images.last_kwargs["image"]), 2)

    def test_generate_sends_non_default_quality_background_and_format(self):
        with workspace_tmp_dir() as tmp_path:
            source = tmp_path / "fridge.png"
            out = tmp_path / "out.webp"
            source.write_bytes(b"source")
            request = CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "quality": "xhigh",
                    "background": "transparent",
                    "output_format": "webp",
                    "items": [{"id": "fridge", "role": "appliance refrigerator", "image_paths": [str(source)]}],
                }
            )
            client = FakeClient()

            result = generate_collage(request, client=client, output_path=out)

            self.assertEqual(result.output_path, out)
            self.assertEqual(result.quality, "xhigh")
            self.assertEqual(result.background, "transparent")
            self.assertEqual(result.output_format, "webp")
            self.assertEqual(client.images.last_kwargs["quality"], "xhigh")
            self.assertEqual(client.images.last_kwargs["background"], "transparent")
            self.assertEqual(client.images.last_kwargs["output_format"], "webp")
            self.assertEqual(out.read_bytes(), b"image-bytes")

    def test_generate_default_output_path_matches_non_default_format(self):
        with workspace_tmp_dir() as tmp_path:
            source = tmp_path / "fridge.png"
            source.write_bytes(b"source")
            request = CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "background": "transparent",
                    "output_format": "webp",
                    "items": [{"id": "fridge", "role": "appliance refrigerator", "image_paths": [str(source)]}],
                }
            )
            client = FakeClient()
            previous_directory = Path.cwd()
            os.chdir(tmp_path)
            try:
                result = generate_collage(request, client=client)
            finally:
                os.chdir(previous_directory)

            self.assertEqual(result.output_path, Path("material_collage.webp"))
            self.assertTrue((tmp_path / result.output_path).is_file())

    def test_generate_rejects_invalid_direct_requests_before_calling_client(self):
        with workspace_tmp_dir() as tmp_path:
            source = tmp_path / "fridge.png"
            source.write_bytes(b"source")
            item = CollageItem(id="fridge", role="appliance refrigerator", image_paths=(source,))
            cases = [
                {"quality": "ultra"},
                {"background": "transparent", "output_format": "jpeg"},
            ]
            for overrides in cases:
                with self.subTest(overrides=overrides):
                    client = FakeClient()
                    request = CollageRequest(collage_type="appliance_collage", items=(item,), **overrides)
                    with self.assertRaises(ValidationError):
                        generate_collage(request, client=client, output_path=tmp_path / "out.png")
                    self.assertIsNone(client.images.last_kwargs)


if __name__ == "__main__":
    unittest.main()
