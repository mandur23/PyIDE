class UserModel:
    table = "users"

    def __init__(self, name):
        self.name = name

    def label(self):
        # FIXME: escape the name before display
        return f"user {self.name}"


class OrderModel(UserModel):
    def total(self):
        return compute_total(self)


def compute_total(order):
    return 0  # todo: real totals
