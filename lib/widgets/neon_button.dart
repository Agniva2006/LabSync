import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../core/constants.dart';

class NeonButton extends StatelessWidget {
  final String text;
  final VoidCallback onPressed;
  final Color color;
  final IconData? icon;
  final bool isLoading;

  const NeonButton({
    super.key,
    required this.text,
    required this.onPressed,
    this.color = AppColors.neonCyan,
    this.icon,
    this.isLoading = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: isLoading ? null : onPressed,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [color.withOpacity(0.8), color.withOpacity(0.4)],
          ),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color, width: 1.5),
          boxShadow: [
            BoxShadow(
              color: color.withOpacity(0.4),
              blurRadius: 15,
              spreadRadius: 0,
            ),
          ],
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isLoading)
              SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                    color: AppColors.bgDark, strokeWidth: 2),
              )
            else ...[
              if (icon != null) ...[
                Icon(icon, color: AppColors.bgDark, size: 20),
                const SizedBox(width: 8),
              ],
              Text(
                text.toUpperCase(),
                style: TextStyle(
                  color: AppColors.bgDark,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.5,
                  fontSize: 16,
                ),
              ),
            ],
          ],
        ),
      ),
    )
        .animate(onPlay: (controller) => controller.repeat())
        .shimmer(duration: 2000.ms, color: color.withOpacity(0.2));
  }
}
