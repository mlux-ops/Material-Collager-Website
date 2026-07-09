import json
import unittest

from material_collager.models import CollageRequest
from material_collager.qa import _parse_qa_text, review_collage
from test_helpers import workspace_tmp_dir


class FakeResponses:
    def __init__(self):
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return type(
            "Response",
            (),
            {
                "output_text": json.dumps(
                    {
                        "passed": True,
                        "findings": [],
                        "recommendation": "Use the generated collage.",
                    }
                )
            },
        )()


class FakeClient:
    def __init__(self):
        self.responses = FakeResponses()


class QATests(unittest.TestCase):
    def test_parse_qa_json(self):
        result = _parse_qa_text(
            '{"passed": false, "findings": ["background is gray"], "recommendation": "regenerate"}'
        )

        self.assertFalse(result.passed)
        self.assertEqual(result.findings, ["background is gray"])
        self.assertEqual(result.recommendation, "regenerate")

    def test_review_sends_generated_and_reference_images(self):
        with workspace_tmp_dir() as tmp_path:
            generated = tmp_path / "generated.png"
            ref = tmp_path / "ref.png"
            generated.write_bytes(b"generated")
            ref.write_bytes(b"reference")
            request = CollageRequest.from_dict(
                {
                    "collage_type": "appliance_collage",
                    "items": [
                        {
                            "id": "fridge",
                            "role": "appliance refrigerator",
                            "image_paths": [str(ref)],
                        }
                    ],
                }
            )
            client = FakeClient()

            result = review_collage(generated, request, client=client, model="qa-model")

            self.assertTrue(result.passed)
            self.assertEqual(client.responses.last_kwargs["model"], "qa-model")
            content = client.responses.last_kwargs["input"][0]["content"]
            image_inputs = [part for part in content if part["type"] == "input_image"]
            self.assertEqual(len(image_inputs), 2)
            self.assertTrue(image_inputs[0]["image_url"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
