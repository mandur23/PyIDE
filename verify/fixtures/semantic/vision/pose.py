class FallDetector:
    """Decide whether a person fell from pose landmarks."""

    def __init__(self, threshold=0.35):
        self.threshold = threshold

    def is_fall(self, landmarks):
        hip_drop = landmarks["hip_y_velocity"]
        return hip_drop > self.threshold and landmarks["torso_angle"] > 60
