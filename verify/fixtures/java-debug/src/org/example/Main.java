package org.example;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Main {
    record Person(String name, int age) {}

    static int square(int x) {
        int result = x * x;
        return result;
    }

    static int total(List<Integer> xs) {
        int sum = 0;
        for (int x : xs) {
            sum += x;
        }
        return sum;
    }

    public static void main(String[] args) {
        int[] numbers = {3, 1, 4};
        List<String> names = new ArrayList<>(List.of("kim", "lee"));
        Map<String, Integer> ages = new HashMap<>();
        ages.put("kim", 30);
        Person p = new Person("김민수", 42);
        String greeting = "안녕하세요";
        double ratio = 0.5;
        int s = square(numbers.length);
        System.out.println("s = " + s);
        int t = total(List.of(1, 2, 3));
        System.out.println("t = " + t + ", " + greeting);
        System.out.println("ratio = " + ratio);
        System.out.println("done");
    }
}
