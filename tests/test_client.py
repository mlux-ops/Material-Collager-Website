import base64
import unittest

from material_collager.client import generate_collage
from material_collager.models import CollageRequest
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
            self.assertEqual(result.model, "gpt-image-2")
            self.assertEqual(client.images.last_kwargs["model"], "gpt-image-2")
            self.assertEqual(client.images.last_kwargs["size"], "1536x1024")
            self.assertEqual(client.images.last_kwargs["quality"], "high")
            self.assertEqual(client.images.last_kwargs["background"], "opaque")
            self.assertEqual(len(client.images.last_kwargs["image"]), 2)


if __name__ == "__main__":
    unittest.main()
