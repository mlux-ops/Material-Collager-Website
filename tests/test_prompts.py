import unittest

from material_collager.models import CollageRequest
from material_collager.prompts import build_generation_prompt


class PromptTests(unittest.TestCase):
    def test_prompt_labels_image_roles_without_visual_handoff(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "bathroom_fixture_collage",
                "items": [
                    {
                        "id": "faucet",
                        "role": "vanity faucet",
                        "image_paths": ["faucet.png", "faucet-side.png"],
                        "finish": "matte black",
                    },
                    {
                        "id": "tile",
                        "role": "main bathroom tile",
                        "image_paths": ["tile.png"],
                    },
                ],
            }
        )

        prompt = build_generation_prompt(request)

        self.assertIn("Images 1-2: item `faucet`", prompt)
        self.assertIn("Image 3: item `tile`", prompt)
        self.assertIn("uploaded images are the visual source of truth", prompt)
        self.assertNotIn("analyze the reference", prompt.lower())

    def test_appliance_prompt_excludes_greenery(self):
        request = CollageRequest.from_dict(
            {
                "collage_type": "appliance_collage",
                "items": [
                    {
                        "id": "fridge",
                        "role": "appliance refrigerator",
                        "image_paths": ["fridge.png"],
                    }
                ],
            }
        )

        prompt = build_generation_prompt(request)

        self.assertIn("no greenery", prompt.lower())
        self.assertIn("No styling greenery", prompt)


if __name__ == "__main__":
    unittest.main()

