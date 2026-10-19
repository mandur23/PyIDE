import matplotlib.pyplot as plt

fig, ax = plt.subplots(num="Run plot")
ax.plot([1, 2, 3], [4, 1, 9], label="line")
ax.set_title("Run plot")
plt.show()
print("after show")
